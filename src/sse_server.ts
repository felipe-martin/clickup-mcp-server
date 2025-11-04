/**
 * SPDX-FileCopyrightText: © 2025 Talib Kareem
 * SPDX-License-Identifier: MIT
 *
 * SSE and HTTP Streamable Transport Server (dual-stack)
 *
 * - Expone /mcp (HTTP streamable) y /sse (legacy SSE) + /health
 * - Escucha en IPv4/IPv6 según HOST:
 *      HOST = '::' (por defecto) -> dual-stack
 *      HOST = '0.0.0.0'          -> solo IPv4
 * - Pensado para Railway (no fijar PORT; la plataforma lo inyecta).
 */

import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';

import { server, configureServer } from './server.js';
import configuration from './config.js';
import {
  createOriginValidationMiddleware,
  createRateLimitMiddleware,
  createCorsMiddleware,
  createSecurityHeadersMiddleware,
  createSecurityLoggingMiddleware,
  createInputValidationMiddleware
} from './middleware/security.js';
import { Logger } from './logger.js';

const app = express();
const logger = new Logger('SSEServer');

export function startSSEServer() {
  // 1) Config base unificada
  configureServer();

  // 2) Seguridad (opt-in por env)
  logger.info('Configuring security middleware', {
    securityFeatures: configuration.enableSecurityFeatures,
    originValidation: configuration.enableOriginValidation,
    rateLimit: configuration.enableRateLimit,
    cors: configuration.enableCors
  });

  app.use(createInputValidationMiddleware());
  app.use(createSecurityLoggingMiddleware());
  app.use(createSecurityHeadersMiddleware());
  app.use(createCorsMiddleware());
  app.use(createOriginValidationMiddleware());
  app.use(createRateLimitMiddleware());

  // 3) JSON body (tamaño configurable)
  app.use(express.json({
    limit: configuration.maxRequestSize,
    verify: (_req, _res, buf) => {
      if (buf.length === 0) logger.debug('Empty request body received');
    }
  }));

  // 4) Transports en memoria por sesión
  const transports = {
    streamable: {} as Record<string, StreamableHTTPServerTransport>,
    sse: {} as Record<string, SSEServerTransport>,
  };

  // ========== HTTP Streamable ==========
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      logger.debug('MCP request received', {
        sessionId,
        hasBody: !!req.body,
        contentType: req.headers['content-type'],
        origin: req.headers.origin
      });

      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.streamable[sessionId]) {
        transport = transports.streamable[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `session_${Date.now()}_${Math.random().toString(36).slice(2, 15)}`,
          onsessioninitialized: (sid) => { transports.streamable[sid] = transport; }
        });

        transport.onclose = () => {
          if (transport.sessionId) delete transports.streamable[transport.sessionId];
        };

        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.streamable[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    const transport = transports.streamable[sessionId];
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  // ========== Legacy SSE ==========
  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports.sse[transport.sessionId] = transport;

    logger.info('New SSE connection established', {
      sessionId: transport.sessionId,
      origin: req.headers.origin,
      userAgent: req.headers['user-agent']
    });

    res.on('close', () => { delete transports.sse[transport.sessionId]; });
    await server.connect(transport);
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.sse[sessionId];
    if (transport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(400).send('No transport found for sessionId');
    }
  });

  // ========== Health ==========
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '0.8.3',
      security: {
        featuresEnabled: configuration.enableSecurityFeatures,
        originValidation: configuration.enableOriginValidation,
        rateLimit: configuration.enableRateLimit,
        cors: configuration.enableCors
      }
    });
  });

  // ========== Startup (dual-stack) ==========
  const PORT = Number(configuration.port ?? process.env.PORT ?? '3231');
  const HTTPS_PORT = Number(configuration.httpsPort ?? '3443');

  // HOST precedence: config.host > HOST > BIND_HOST > default '::' (dual-stack)
  const HOST =
    (configuration as any).host ||
    process.env.HOST ||
    process.env.BIND_HOST ||
    '::';

  function startHttpServer() {
    const httpServer = http.createServer(app);
    httpServer.listen(PORT, HOST, () => {
      const base = hostToPrintable(HOST);
      logger.info('ClickUp MCP Server (HTTP) started', {
        host: HOST, port: PORT, protocol: 'http',
        endpoints: {
          streamableHttp: `http://${base}:${PORT}/mcp`,
          legacySSE: `http://${base}:${PORT}/sse`,
          health: `http://${base}:${PORT}/health`
        },
        security: {
          featuresEnabled: configuration.enableSecurityFeatures,
          originValidation: configuration.enableOriginValidation,
          rateLimit: configuration.enableRateLimit,
          cors: configuration.enableCors,
          httpsEnabled: configuration.enableHttps
        }
      });
      console.log(`✅ ClickUp MCP Server started on http://${base}:${PORT}`);
      console.log(`📡 Streamable HTTP endpoint: http://${base}:${PORT}/mcp`);
      console.log(`🔄 Legacy SSE endpoint: http://${base}:${PORT}/sse`);
      console.log(`❤️  Health check: http://${base}:${PORT}/health`);

      if (configuration.enableHttps) {
        console.log('⚠️  HTTP server running alongside HTTPS - consider disabling HTTP in production');
      }
    });
    return httpServer;
  }

  function startHttpsServer() {
    if (!configuration.enableHttps) return null;

    if (!configuration.sslKeyPath || !configuration.sslCertPath) {
      logger.error('HTTPS enabled but SSL certificate paths not provided', {
        sslKeyPath: configuration.sslKeyPath,
        sslCertPath: configuration.sslCertPath
      });
      console.log('❌ HTTPS enabled but SSL_KEY_PATH and SSL_CERT_PATH not provided');
      return null;
    }

    try {
      if (!fs.existsSync(configuration.sslKeyPath)) {
        throw new Error(`SSL key file not found: ${configuration.sslKeyPath}`);
      }
      if (!fs.existsSync(configuration.sslCertPath)) {
        throw new Error(`SSL certificate file not found: ${configuration.sslCertPath}`);
      }

      const httpsOptions: https.ServerOptions = {
        key: fs.readFileSync(configuration.sslKeyPath),
        cert: fs.readFileSync(configuration.sslCertPath),
        ca: configuration.sslCaPath && fs.existsSync(configuration.sslCaPath)
          ? fs.readFileSync(configuration.sslCaPath)
          : undefined,
      };

      const httpsServer = https.createServer(httpsOptions, app);
      httpsServer.listen(HTTPS_PORT, HOST, () => {
        const base = hostToPrintable(HOST);
        logger.info('ClickUp MCP Server (HTTPS) started', {
          host: HOST, port: HTTPS_PORT, protocol: 'https',
          endpoints: {
            streamableHttp: `https://${base}:${HTTPS_PORT}/mcp`,
            legacySSE: `https://${base}:${HTTPS_PORT}/sse`,
            health: `https://${base}:${HTTPS_PORT}/health`
          },
          security: {
            featuresEnabled: configuration.enableSecurityFeatures,
            originValidation: configuration.enableOriginValidation,
            rateLimit: configuration.enableRateLimit,
            cors: configuration.enableCors,
            httpsEnabled: true
          }
        });
        console.log(`🔒 ClickUp MCP Server (HTTPS) started on https://${base}:${HTTPS_PORT}`);
        console.log(`📡 Streamable HTTPS endpoint: https://${base}:${HTTPS_PORT}/mcp`);
        console.log(`🔄 Legacy SSE HTTPS endpoint: https://${base}:${HTTPS_PORT}/sse`);
        console.log(`❤️  Health check HTTPS: https://${base}:${HTTPS_PORT}/health`);
      });
      return httpsServer;
    } catch (_e) {
      logger.error('Failed to start HTTPS server', {
        error: 'An error occurred while starting HTTPS server.',
        sslKeyPath: 'REDACTED',
        sslCertPath: 'REDACTED'
      });
      console.log('❌ Failed to start HTTPS server. Please check the server configuration and logs for details.');
      return null;
    }
  }

  const servers: (http.Server | https.Server | null)[] = [];
  servers.push(startHttpServer());
  const httpsSrv = startHttpsServer();
  if (httpsSrv) servers.push(httpsSrv);

  // Estado de seguridad en logs
  console.log(configuration.enableSecurityFeatures
    ? '🔒 Security features enabled'
    : '⚠️  Security features disabled (set ENABLE_SECURITY_FEATURES=true to enable)');
  if (!configuration.enableHttps) {
    console.log('⚠️  HTTPS disabled (set ENABLE_HTTPS=true with SSL certificates to enable)');
  }

  return servers.filter(Boolean) as (http.Server | https.Server)[];
}

/** Muestra host bonito en logs (maneja :: y 0.0.0.0 con corchetes IPv6) */
function hostToPrintable(host: string) {
  if (!host) return '0.0.0.0';
  // Si es IPv6 literal o '::', usa [host]
  if (host.includes(':')) return `[${host}]`;
  return host;
}
