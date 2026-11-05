#!/usr/bin/env node
/**
 * SAP CPI Inbound API Client Generator (Postman v2.1 & OpenAPI 3.0)
 * Zero external dependencies.
 * Analyzes an Integration Flow (.zip), detects HTTPS/REST/SOAP inbound sender channels,
 * extracts CSRF protection requirements, synthesizes sample payloads from embedded XSDs,
 * and exports ready-to-test Postman Collections and OpenAPI 3.0 contracts.
 *
 * Usage:
 *   node export-api-client.mjs --demo [--format postman|openapi|both] [--out-dir <dir>] [--json]
 *   node export-api-client.mjs <iflow.zip> [--format postman|openapi|both] [--out-dir <dir>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectBundle, buildDemoBundleZipBuffer } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';

function extractInboundEndpointsFromIflw(iflwXml) {
  const endpoints = [];
  if (iflwXml) {
    // Find sender messageFlows (from Participant_Sender to StartEvent)
    const mfRegex = /<bpmn2:messageFlow\b([^>]*)>([\s\S]*?)<\/bpmn2:messageFlow>/gi;
    let m;

    while ((m = mfRegex.exec(iflwXml)) !== null) {
      const attrs = m[1];
      const body = m[2];
      const sourceRefMatch = attrs.match(/\bsourceRef="([^"]+)"/);
      const sourceRef = sourceRefMatch ? sourceRefMatch[1] : '';

      // Check if sourceRef is an EndpointSender participant or Sender
      const isSender =
        /Sender/i.test(sourceRef) ||
        body.includes('ifl:type="EndpointSender"') ||
        body.includes('<ifl:property key="direction" value="Sender"/>');

      if (isSender || /HTTPS|SOAP|REST|OData/i.test(body)) {
        const getProp = (key) => {
          const match =
            body.match(new RegExp(`<ifl:property[^>]*key="${key}"[^>]*value="([^"]*)"`, 'i')) ||
            body.match(new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`, 'i'));
          return match ? match[1] : '';
        };

        const address = getProp('address') || getProp('url') || '/cpi/inbound';
        const protocol = getProp('MessageProtocol') || getProp('system') || 'HTTPS';
        const xsrfVal = getProp('xsrfProtection');
        const xsrfProtection = xsrfVal === '1' || xsrfVal === 'true';

        endpoints.push({
          id: (attrs.match(/\bid="([^"]+)"/) || [])[1] || 'MessageFlow_In',
          name: (attrs.match(/\bname="([^"]+)"/) || [])[1] || 'Inbound_Endpoint',
          protocol,
          address,
          xsrfProtection
        });
      }
    }
  }

  if (endpoints.length === 0) {
    // Default fallback if not explicit
    endpoints.push({
      id: 'MessageFlow_Inbound_Default',
      name: 'HTTPS_Inbound',
      protocol: 'HTTPS',
      address: '/b2b/v1/orders',
      xsrfProtection: true
    });
  }

  return endpoints;
}

function synthesizeSampleFromXsd(xsdText) {
  if (!xsdText) return '<Request><sample>test</sample></Request>';
  const rootMatch = xsdText.match(/<xsd:element\b[^>]*\bname="([^"]+)"/i);
  const rootTag = rootMatch ? rootMatch[1] : 'Root';

  const childMatches = [...xsdText.matchAll(/<xsd:element\b[^>]*\bname="([^"]+)"[^>]*\btype="([^"]+)"/gi)];
  const children = [];
  for (const cm of childMatches) {
    const cName = cm[1];
    const cType = cm[2];
    if (cName === rootTag) continue;
    let sampleVal = 'SAMPLE-100';
    if (cType.includes('integer') || cType.includes('int')) sampleVal = '100';
    else if (cType.includes('decimal')) sampleVal = '99.50';
    else if (cType.includes('boolean')) sampleVal = 'true';
    else if (cType.includes('date')) sampleVal = '2026-11-05';
    children.push(`        <${cName}>${sampleVal}</${cName}>`);
  }

  if (children.length === 0) {
    children.push('        <id>SAMPLE-001</id>');
    children.push('        <status>NEW</status>');
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<${rootTag}>\n${children.join('\n')}\n</${rootTag}>`;
}

export function generatePostmanCollection(report) {
  const iflowName = report.manifestData?.name || path.basename(report.fileName, '.zip');
  const iflwXml = report.catalog.iflwFiles[0]?.text || '';
  const endpoints = extractInboundEndpointsFromIflw(iflwXml);
  const primaryEndpoint = endpoints[0];

  const firstXsd = report.catalog.xsdSchemas[0]?.text || '';
  const sampleBody = synthesizeSampleFromXsd(firstXsd);

  const cleanPath = primaryEndpoint.address.replace(/^\/+/, '');
  const items = [];

  if (primaryEndpoint.xsrfProtection) {
    // Step 1: CSRF Token Fetch Request
    items.push({
      name: '1. Fetch X-CSRF-Token (Handshake)',
      request: {
        method: 'GET',
        header: [
          { key: 'X-CSRF-Token', value: 'Fetch', type: 'text' },
          { key: 'Authorization', value: 'Basic {{CPI_BASIC_AUTH}}', type: 'text' }
        ],
        url: {
          raw: `{{CPI_TENANT_BASE_URL}}/http/${cleanPath}`,
          host: ['{{CPI_TENANT_BASE_URL}}'],
          path: ['http', ...cleanPath.split('/')]
        },
        description: 'Solicita un token CSRF válido para autorizar peticiones modificadoras (POST/PUT/DELETE) en SAP CPI.'
      },
      event: [
        {
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: [
              'pm.test("Status code is 200 or 204", function () {',
              '    pm.expect(pm.response.code).to.be.oneOf([200, 204]);',
              '});',
              'var csrfToken = pm.response.headers.get("X-CSRF-Token");',
              'if (csrfToken) {',
              '    pm.environment.set("cpi_csrf_token", csrfToken);',
              '    console.log("X-CSRF-Token guardado:", csrfToken);',
              '}'
            ]
          }
        }
      ]
    });
  }

  // Step 2 (or 1): Send Message Request
  const postHeaders = [
    { key: 'Content-Type', value: 'application/xml', type: 'text' },
    { key: 'Authorization', value: 'Basic {{CPI_BASIC_AUTH}}', type: 'text' }
  ];
  if (primaryEndpoint.xsrfProtection) {
    postHeaders.splice(1, 0, { key: 'X-CSRF-Token', value: '{{cpi_csrf_token}}', type: 'text' });
  }

  items.push({
    name: `${primaryEndpoint.xsrfProtection ? '2. ' : '1. '}Send Message (${iflowName})`,
    request: {
      method: 'POST',
      header: postHeaders,
      body: {
        mode: 'raw',
        raw: sampleBody,
        options: {
          raw: { language: 'xml' }
        }
      },
      url: {
        raw: `{{CPI_TENANT_BASE_URL}}/http/${cleanPath}`,
        host: ['{{CPI_TENANT_BASE_URL}}'],
        path: ['http', ...cleanPath.split('/')]
      },
      description: `Dispara la ejecución del Integration Flow ${iflowName} en SAP CPI.`
    },
    event: [
      {
        listen: 'test',
        script: {
          type: 'text/javascript',
          exec: [
            'pm.test("Successful invocation (200, 201 or 202)", function () {',
            '    pm.expect(pm.response.code).to.be.oneOf([200, 201, 202]);',
            '});'
          ]
        }
      }
    ]
  });

  return {
    info: {
      _postman_id: crypto.randomUUID(),
      name: `${iflowName} — Client API Collection`,
      description: `Colección Postman generada automáticamente para pruebas E2E de ${iflowName} en SAP Integration Suite.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    variable: [
      { key: 'CPI_TENANT_BASE_URL', value: 'https://your-tenant.it-cpi001.cfapps.eu10.hana.ondemand.com', type: 'string' },
      { key: 'CPI_BASIC_AUTH', value: 'dXNlcm5hbWU6cGFzc3dvcmQ=', type: 'string' }
    ],
    item: items
  };
}

export function generateOpenApiSpec(report) {
  const iflowName = report.manifestData?.name || path.basename(report.fileName, '.zip');
  const iflwXml = report.catalog.iflwFiles[0]?.text || '';
  const endpoints = extractInboundEndpointsFromIflw(iflwXml);
  const primaryEndpoint = endpoints[0];

  const firstXsd = report.catalog.xsdSchemas[0]?.text || '';
  const sampleBody = synthesizeSampleFromXsd(firstXsd);

  const cleanPath = '/' + primaryEndpoint.address.replace(/^\/+/, '');

  const parameters = [];
  if (primaryEndpoint.xsrfProtection) {
    parameters.push({
      name: 'X-CSRF-Token',
      in: 'header',
      required: true,
      description: 'Token CSRF obtenido previamente mediante handshake X-CSRF-Token: Fetch.',
      schema: { type: 'string', example: 'eGNoLWNwcmlzLXRva2VuLTAwMQ==' }
    });
  }

  const paths = {
    [cleanPath]: {
      post: {
        tags: ['Integration Inbound Endpoints'],
        summary: `Enviar mensaje al Integration Flow ${iflowName}`,
        description: `Endpoint de integración expuesto en SAP Cloud Integration sobre protocolo ${primaryEndpoint.protocol}.`,
        parameters,
        requestBody: {
          required: true,
          content: {
            'application/xml': {
              schema: { type: 'string' },
              example: sampleBody
            }
          }
        },
        responses: {
          '200': {
            description: 'Mensaje procesado exitosamente por el iFlow.',
            content: {
              'application/xml': { schema: { type: 'string' } },
              'application/json': { schema: { type: 'object' } }
            }
          },
          '500': {
            description: 'Error capturado en el Exception Subprocess de SAP CPI.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'Failed' },
                    message: { type: 'string', example: 'CPI-ERR: Database connection timeout' }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  return {
    openapi: '3.0.3',
    info: {
      title: `${iflowName} API Interface`,
      description: `Contrato OpenAPI 3.0 para el Integration Flow ${iflowName} en SAP Integration Suite.`,
      version: report.manifestData?.version || '1.0.0'
    },
    servers: [
      {
        url: 'https://{tenant-host}.it-cpi001.cfapps.eu10.hana.ondemand.com/http',
        description: 'Tenant Runtime SAP Cloud Integration',
        variables: {
          'tenant-host': { default: 'your-tenant' }
        }
      }
    ],
    paths,
    components: {
      securitySchemes: {
        basicAuth: { type: 'http', scheme: 'basic' },
        cpiOAuth: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://{tenant-oauth-host}.authentication.eu10.hana.ondemand.com/oauth/token',
              scopes: {}
            }
          }
        }
      }
    },
    security: [{ basicAuth: [] }, { cpiOAuth: [] }]
  };
}

export function exportApiClientContracts(bundlePathOrBuf, options = {}) {
  const { format = 'both', outDir = null } = options;
  const report = inspectBundle(bundlePathOrBuf);

  const postman = format === 'postman' || format === 'both' ? generatePostmanCollection(report) : null;
  const openapi = format === 'openapi' || format === 'both' ? generateOpenApiSpec(report) : null;

  const baseName = report.manifestData?.name || path.basename(report.fileName, '.zip');
  const filesWritten = [];

  if (outDir) {
    const targetDir = path.resolve(outDir);
    fs.mkdirSync(targetDir, { recursive: true });

    if (postman) {
      const pmPath = path.join(targetDir, `${baseName}.postman_collection.json`);
      fs.writeFileSync(pmPath, JSON.stringify(postman, null, 2) + '\n', 'utf8');
      filesWritten.push(pmPath);
    }
    if (openapi) {
      const oaPath = path.join(targetDir, `${baseName}.openapi.json`);
      fs.writeFileSync(oaPath, JSON.stringify(openapi, null, 2) + '\n', 'utf8');
      filesWritten.push(oaPath);
    }
  }

  return {
    iflowName: baseName,
    format,
    postman,
    openapi,
    filesWritten
  };
}

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso 1 (Demo): node export-api-client.mjs --demo [--format postman|openapi|both] [--out-dir <dir>] [--json]');
    console.log('Uso 2 (iFlow): node export-api-client.mjs <iflow.zip> [--format postman|openapi|both] [--out-dir <dir>] [--json]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');
  const target = args[0] === '--demo' ? buildDemoBundleZipBuffer() : args[0];

  const getOpt = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const format = getOpt('--format', 'both');
  const outDir = getOpt('--out-dir', null);

  const res = exportApiClientContracts(target, { format, outDir });

  if (jsonFlag) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`=== SAP CPI INBOUND API CLIENT GENERATOR ===`);
    console.log(`iFlow: ${res.iflowName} | Formato: ${res.format}`);
    if (res.postman) {
      console.log(`  [OK] Postman Collection v2.1 (${res.postman.item.length} peticiones preparadas con CSRF Flow)`);
    }
    if (res.openapi) {
      console.log(`  [OK] OpenAPI 3.0.3 Contract (${Object.keys(res.openapi.paths).join(', ')})`);
    }
    if (res.filesWritten.length > 0) {
      console.log('\nArchivos exportados:');
      res.filesWritten.forEach((f) => console.log(`  - ${f}`));
    }
  }
}

export { exportApiClientContracts as exportApiClientArtifacts };
