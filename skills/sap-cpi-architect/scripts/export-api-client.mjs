#!/usr/bin/env node
/**
 * SAP CPI Inbound API Client Generator (Postman v2.1 & OpenAPI 3.0)
 * Zero external dependencies.
 * Analyzes an Integration Flow (.zip), detects HTTPS/REST/SOAP inbound sender channels,
 * extracts CSRF protection requirements, synthesizes sample payloads from embedded XSDs,
 * and exports ready-to-test Postman Collections and OpenAPI 3.0 contracts.
 *
 * Usage:
 *   node export-api-client.mjs --demo [--format postman|openapi|both] [--out-dir <dir>] [--base-url <url>] [--json]
 *   node export-api-client.mjs <iflow.zip> [--format postman|openapi|both] [--out-dir <dir>] [--base-url <url>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectBundle, buildDemoBundleZipBuffer } from '../../sap-cpi-zip-inspector/scripts/inspect-iflow-zip.mjs';

export function extractParametersMap(report) {
  const map = {};
  const propEntry = (report.catalog?.parameterFiles || []).find((f) => f.path.endsWith('parameters.prop'));
  const rawText = propEntry?.content || propEntry?.text || '';
  if (rawText) {
    const lines = rawText.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        map[k] = v;
      }
    }
  }
  return map;
}

export function parseParticipants(iflwXml) {
  const senders = new Set();
  const receivers = new Set();
  if (!iflwXml) return { senders, receivers };
  const pRegex = /<bpmn2:participant\b([^>]*)\/?>/gi;
  let pm;
  while ((pm = pRegex.exec(iflwXml)) !== null) {
    const raw = pm[1];
    const id = (raw.match(/\bid="([^"]+)"/) || [])[1];
    const type = (raw.match(/\bifl:type="([^"]+)"/) || [])[1] || '';
    const name = (raw.match(/\bname="([^"]+)"/) || [])[1] || '';
    if (!id) continue;
    if (/Sender/i.test(type) || /Sender/i.test(name) || /Sender/i.test(id)) {
      senders.add(id);
    } else if (/Receiv?er/i.test(type) || /Receiv?er/i.test(name) || /Receiv?er/i.test(id)) {
      receivers.add(id);
    }
  }
  return { senders, receivers };
}

export function extractInboundEndpointsFromIflw(iflwXml, propMap = {}, options = {}) {
  const { allowFallback = true } = options;
  const endpoints = [];
  if (iflwXml) {
    const { senders, receivers } = parseParticipants(iflwXml);
    // Find sender messageFlows (from Participant_Sender to StartEvent)
    const mfRegex = /<bpmn2:messageFlow\b([^>]*)>([\s\S]*?)<\/bpmn2:messageFlow>/gi;
    let m;

    while ((m = mfRegex.exec(iflwXml)) !== null) {
      const attrs = m[1];
      const body = m[2];
      const sourceRefMatch = attrs.match(/\bsourceRef="([^"]+)"/);
      const sourceRef = sourceRefMatch ? sourceRefMatch[1] : '';
      const targetRefMatch = attrs.match(/\btargetRef="([^"]+)"/);
      const targetRef = targetRefMatch ? targetRefMatch[1] : '';

      // Check if sourceRef is an EndpointSender participant or Sender
      const isSender =
        senders.has(sourceRef) ||
        /Sender/i.test(sourceRef) ||
        body.includes('ifl:type="EndpointSender"') ||
        body.includes('<ifl:property key="direction" value="Sender"/>');

      const isReceiver =
        receivers.has(targetRef) ||
        /Receiver/i.test(targetRef) ||
        body.includes('ifl:type="EndpointReceiver"') ||
        body.includes('ifl:type="EndpointRecevier"') ||
        body.includes('<ifl:property key="direction" value="Receiver"/>');

      if ((isSender || /HTTPS|SOAP|REST|OData/i.test(body)) && !isReceiver) {
        const getProp = (key) => {
          const match =
            body.match(new RegExp(`<ifl:property[^>]*key="${key}"[^>]*value="([^"]*)"`, 'i')) ||
            body.match(new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`, 'i'));
          return match ? match[1] : '';
        };

        const rawAddress = getProp('address') || getProp('url') || '/cpi/inbound';
        let address = rawAddress;
        // Resolve externalized parameter if defined like {{ParamName}}
        const extMatch = rawAddress.match(/^\{\{([^}]+)\}\}$/);
        if (extMatch && propMap[extMatch[1]]) {
          address = propMap[extMatch[1]];
        }

        const protocol = getProp('MessageProtocol') || getProp('system') || getProp('ComponentType') || 'HTTPS';
        const xsrfVal = getProp('xsrfProtection');
        const xsrfProtection = xsrfVal === '1' || xsrfVal === 'true';

        endpoints.push({
          id: (attrs.match(/\bid="([^"]+)"/) || [])[1] || 'MessageFlow_In',
          name: (attrs.match(/\bname="([^"]+)"/) || [])[1] || 'Inbound_Endpoint',
          protocol,
          address,
          rawAddress,
          isExternalized: Boolean(extMatch),
          xsrfProtection,
          isCsrfProtected: xsrfProtection
        });
      }
    }
  }

  if (endpoints.length === 0 && allowFallback) {
    // Default fallback if not explicit
    endpoints.push({
      id: 'MessageFlow_Inbound_Default',
      name: 'HTTPS_Inbound',
      protocol: 'HTTPS',
      address: '/b2b/v1/orders',
      rawAddress: '/b2b/v1/orders',
      isExternalized: false,
      xsrfProtection: true,
      isCsrfProtected: true
    });
  }

  return endpoints;
}

export function extractOutboundEndpointsFromIflw(iflwXml, propMap = {}) {
  const endpoints = [];
  if (iflwXml) {
    const { receivers } = parseParticipants(iflwXml);
    const mfRegex = /<bpmn2:messageFlow\b([^>]*)>([\s\S]*?)<\/bpmn2:messageFlow>/gi;
    let m;
    while ((m = mfRegex.exec(iflwXml)) !== null) {
      const attrs = m[1];
      const body = m[2];
      const targetRefMatch = attrs.match(/\btargetRef="([^"]+)"/);
      const targetRef = targetRefMatch ? targetRefMatch[1] : '';

      const isReceiver =
        receivers.has(targetRef) ||
        /Receiver/i.test(targetRef) ||
        body.includes('ifl:type="EndpointReceiver"') ||
        body.includes('ifl:type="EndpointRecevier"') ||
        body.includes('<ifl:property key="direction" value="Receiver"/>');

      if (isReceiver) {
        const getProp = (key) => {
          const match =
            body.match(new RegExp(`<ifl:property[^>]*key="${key}"[^>]*value="([^"]*)"`, 'i')) ||
            body.match(new RegExp(`<key>${key}</key>\\s*<value>([^<]*)</value>`, 'i'));
          return match ? match[1] : '';
        };

        let rawAddress = getProp('address') || getProp('url') || getProp('location') || '';
        let resolvedAddress = rawAddress;
        const extMatch = rawAddress.match(/^\{\{([^}]+)\}\}$/);
        if (extMatch && propMap[extMatch[1]]) {
          resolvedAddress = propMap[extMatch[1]];
        }

        const componentType = getProp('ComponentType') || getProp('system') || 'HTTP';
        const rawTimeout = getProp('httpRequestTimeout') || getProp('timeout') || 'Default';
        let resolvedTimeout = rawTimeout;
        const timeoutExtMatch = rawTimeout.match(/^\{\{([^}]+)\}\}$/);
        if (timeoutExtMatch && propMap[timeoutExtMatch[1]]) {
          resolvedTimeout = propMap[timeoutExtMatch[1]];
        }

        const isSecure = /^https:\/\//i.test(resolvedAddress) || (!/^http:\/\//i.test(resolvedAddress) && !/^http:\/\//i.test(rawAddress));

        endpoints.push({
          id: (attrs.match(/\bid="([^"]+)"/) || [])[1] || 'MessageFlow_Out',
          name: (attrs.match(/\bname="([^"]+)"/) || [])[1] || 'Outbound_Endpoint',
          targetRef,
          adapterType: componentType,
          address: rawAddress,
          resolvedAddress,
          isExternalized: Boolean(extMatch),
          timeout: resolvedTimeout,
          rawTimeout: Boolean(timeoutExtMatch) ? rawTimeout : undefined,
          isSecure
        });
      }
    }
  }
  return endpoints;
}

export function extractIflowEndpointsSummary(bundlePathOrBuf, options = {}) {
  const target = bundlePathOrBuf === '--demo' ? buildDemoBundleZipBuffer() : bundlePathOrBuf;
  const report = inspectBundle(target, null, { showPropValues: true });

  const iflwEntry = report.catalog?.iflwFiles?.[0];
  const iflwXml = iflwEntry?.text || '';

  if (!iflwXml || !iflwEntry) {
    return {
      valid: false,
      error: 'El archivo ZIP no contiene ninguna definición de Integration Flow (.iflw). Es probable que sea una Script Collection o Value Mapping.',
      iflowName: report.manifestData?.name || (report.fileName ? path.basename(report.fileName, '.zip') : 'Unknown'),
      symbolicName: report.manifestData?.symbolicName || 'N/A',
      version: report.manifestData?.version || '1.0.0',
      totalInbound: 0,
      totalOutbound: 0,
      inboundEndpoints: [],
      outboundEndpoints: [],
      processDirectEndpoints: [],
      externalizedParameters: []
    };
  }

  const propMap = extractParametersMap(report);
  const inbounds = extractInboundEndpointsFromIflw(iflwXml, propMap, { allowFallback: false });
  const outbounds = extractOutboundEndpointsFromIflw(iflwXml, propMap);

  const processDirectRegex = /<ifl:property[^>]*key="address"[^>]*value="(\/[^"]+)"/gi;
  const directChannels = [];
  let pdMatch;
  while ((pdMatch = processDirectRegex.exec(iflwXml)) !== null) {
    if (iflwXml.includes('ProcessDirect') && !inbounds.some((i) => i.address === pdMatch[1])) {
      directChannels.push(pdMatch[1]);
    }
  }

  return {
    valid: true,
    iflowName: report.manifestData?.name || (report.fileName ? path.basename(report.fileName, '.zip') : 'iFlow'),
    symbolicName: report.manifestData?.symbolicName || 'N/A',
    version: report.manifestData?.version || '1.0.0',
    totalInbound: inbounds.length,
    totalOutbound: outbounds.length,
    inboundEndpoints: inbounds,
    outboundEndpoints: outbounds,
    processDirectEndpoints: [...new Set(directChannels)],
    externalizedParameters: Object.keys(propMap).map((k) => ({
      key: k,
      configuredInAdapters:
        inbounds.some((i) => i.address === `{{${k}}}` || i.rawAddress === `{{${k}}}`) ||
        outbounds.some((o) => o.address === `{{${k}}}` || o.rawAddress === `{{${k}}}` || o.timeout === `{{${k}}}` || o.rawTimeout === `{{${k}}}`)
    }))
  };
}

export function synthesizeSampleFromXsd(xsdText) {
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

export function synthesizeSampleJsonFromXsd(xsdText) {
  if (!xsdText) return { sample: 'test' };
  const rootMatch = xsdText.match(/<xsd:element\b[^>]*\bname="([^"]+)"/i);
  const rootTag = rootMatch ? rootMatch[1] : 'Root';

  const childMatches = [...xsdText.matchAll(/<xsd:element\b[^>]*\bname="([^"]+)"[^>]*\btype="([^"]+)"/gi)];
  const obj = {};
  for (const cm of childMatches) {
    const cName = cm[1];
    const cType = cm[2];
    if (cName === rootTag) continue;
    let sampleVal = 'SAMPLE-100';
    if (cType.includes('integer') || cType.includes('int')) sampleVal = 100;
    else if (cType.includes('decimal')) sampleVal = 99.5;
    else if (cType.includes('boolean')) sampleVal = true;
    else if (cType.includes('date')) sampleVal = '2026-11-05';
    obj[cName] = sampleVal;
  }
  if (Object.keys(obj).length === 0) {
    obj.id = 'SAMPLE-001';
    obj.status = 'NEW';
  }
  return obj;
}

export function generatePostmanCollection(report, options = {}) {
  const { baseUrl = null, propMap = {} } = options;
  const iflowName = report.manifestData?.name || path.basename(report.fileName, '.zip');
  const iflwXml = report.catalog.iflwFiles[0]?.text || '';
  const endpoints = extractInboundEndpointsFromIflw(iflwXml, propMap);
  const primaryEndpoint = endpoints[0];

  const firstXsd = report.catalog.xsdSchemas[0]?.text || '';
  const sampleBody = synthesizeSampleFromXsd(firstXsd);

  const cleanPath = primaryEndpoint.address.replace(/^\/+/, '');
  const items = [];

  const defaultBaseUrl = baseUrl || 'https://your-tenant.it-cpi001.cfapps.eu10.hana.ondemand.com';

  if (primaryEndpoint.xsrfProtection) {
    // Step 1: CSRF Token Fetch Request (Manual handshake inspection)
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
              'var csrfToken = pm.response.headers.get("X-CSRF-Token") || pm.response.headers.get("x-csrf-token");',
              'if (csrfToken) {',
              '    pm.environment.set("cpi_csrf_token", csrfToken);',
              '    pm.variables.set("cpi_csrf_token", csrfToken);',
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

  const postEvents = [];
  if (primaryEndpoint.xsrfProtection) {
    postEvents.push({
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: [
          '// Pre-request script: Automated CSRF Token Handshake for SAP CPI',
          'var baseUrl = pm.variables.get("CPI_TENANT_BASE_URL") || "' + defaultBaseUrl + '";',
          'var auth = pm.variables.get("CPI_BASIC_AUTH") || "dXNlcm5hbWU6cGFzc3dvcmQ=";',
          'var tokenUrl = baseUrl.replace(/\\/+$/, "") + "/http/' + cleanPath + '";',
          'pm.sendRequest({',
          '    url: tokenUrl,',
          '    method: "GET",',
          '    header: {',
          '        "X-CSRF-Token": "Fetch",',
          '        "Authorization": "Basic " + auth',
          '    }',
          '}, function (err, res) {',
          '    if (!err && res) {',
          '        var token = res.headers.get("X-CSRF-Token") || res.headers.get("x-csrf-token");',
          '        if (token) {',
          '            pm.environment.set("cpi_csrf_token", token);',
          '            pm.variables.set("cpi_csrf_token", token);',
          '            console.log("Automated X-CSRF-Token handshake succeeded:", token);',
          '        }',
          '    }',
          '});'
        ]
      }
    });
  }
  postEvents.push({
    listen: 'test',
    script: {
      type: 'text/javascript',
      exec: [
        'pm.test("Successful invocation (200, 201 or 202)", function () {',
        '    pm.expect(pm.response.code).to.be.oneOf([200, 201, 202]);',
        '});'
      ]
    }
  });

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
    event: postEvents
  });

  return {
    info: {
      _postman_id: crypto.randomUUID(),
      name: `${iflowName} — Client API Collection`,
      description: `Colección Postman generada automáticamente para pruebas E2E de ${iflowName} en SAP Integration Suite.`,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    variable: [
      { key: 'CPI_TENANT_BASE_URL', value: defaultBaseUrl, type: 'string' },
      { key: 'CPI_BASIC_AUTH', value: 'dXNlcm5hbWU6cGFzc3dvcmQ=', type: 'string' }
    ],
    item: items
  };
}

export function generateOpenApiSpec(report, options = {}) {
  const { baseUrl = null, propMap = {} } = options;
  const iflowName = report.manifestData?.name || path.basename(report.fileName, '.zip');
  const iflwXml = report.catalog.iflwFiles[0]?.text || '';
  const endpoints = extractInboundEndpointsFromIflw(iflwXml, propMap);
  const primaryEndpoint = endpoints[0];

  const firstXsd = report.catalog.xsdSchemas[0]?.text || '';
  const sampleBodyXml = synthesizeSampleFromXsd(firstXsd);
  const sampleBodyJson = synthesizeSampleJsonFromXsd(firstXsd);

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
              example: sampleBodyXml
            },
            'application/json': {
              schema: { type: 'object' },
              example: sampleBodyJson
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

  const servers = baseUrl
    ? [
        {
          url: `${baseUrl.replace(/\/+$/, '')}/http`,
          description: 'Tenant Runtime SAP Cloud Integration'
        }
      ]
    : [
        {
          url: 'https://{tenant-host}.it-cpi001.cfapps.eu10.hana.ondemand.com/http',
          description: 'Tenant Runtime SAP Cloud Integration',
          variables: {
            'tenant-host': { default: 'your-tenant' }
          }
        }
      ];

  return {
    openapi: '3.0.3',
    info: {
      title: `${iflowName} API Interface`,
      description: `Contrato OpenAPI 3.0 para el Integration Flow ${iflowName} en SAP Integration Suite.`,
      version: report.manifestData?.version || '1.0.0'
    },
    servers,
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
  const { format = 'both', outDir = null, baseUrl = null, authType = 'basic' } = options;
  const report = inspectBundle(bundlePathOrBuf, null, { showPropValues: true });
  const propMap = extractParametersMap(report);

  const postman = format === 'postman' || format === 'both' ? generatePostmanCollection(report, { baseUrl, authType, propMap }) : null;
  const openapi = format === 'openapi' || format === 'both' ? generateOpenApiSpec(report, { baseUrl, propMap }) : null;

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
    console.log('Uso 1 (Demo): node export-api-client.mjs --demo [--format postman|openapi|both] [--out-dir <dir>] [--base-url <url>] [--json]');
    console.log('Uso 2 (iFlow): node export-api-client.mjs <iflow.zip> [--format postman|openapi|both] [--out-dir <dir>] [--base-url <url>] [--json]');
    console.log('Uso 3 (Endpoints): node export-api-client.mjs <iflow.zip|--demo> --endpoints [--json]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');
  const endpointsFlag = args.includes('--endpoints');
  const target = args[0] === '--demo' ? buildDemoBundleZipBuffer() : args[0];

  if (endpointsFlag) {
    const res = extractIflowEndpointsSummary(target);
    if (jsonFlag) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      console.log(`=== SAP CPI IFLOW ENDPOINTS SUMMARY ===`);
      console.log(`iFlow: ${res.iflowName} (${res.symbolicName} v${res.version})`);
      console.log(`Válido: ${res.valid}`);
      if (!res.valid) {
        console.log(`Error: ${res.error}`);
      } else {
        console.log(`Inbound (${res.totalInbound}):`);
        res.inboundEndpoints.forEach((i) => console.log(`  - [${i.protocol}] ${i.address} (CSRF: ${i.isCsrfProtected})`));
        console.log(`Outbound (${res.totalOutbound}):`);
        res.outboundEndpoints.forEach((o) =>
          console.log(`  - [${o.adapterType}] ${o.resolvedAddress || o.address} (Timeout: ${o.timeout}, Secure: ${o.isSecure})`)
        );
      }
    }
    process.exit(0);
  }

  const getOpt = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const format = getOpt('--format', 'both');
  const outDir = getOpt('--out-dir', null);
  const baseUrl = getOpt('--base-url', null);

  const res = exportApiClientContracts(target, { format, outDir, baseUrl });

  if (jsonFlag) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`=== SAP CPI INBOUND API CLIENT GENERATOR ===`);
    console.log(`iFlow: ${res.iflowName} | Formato: ${res.format}`);
    if (baseUrl) {
      console.log(`Base URL: ${baseUrl}`);
    }
    if (res.postman) {
      console.log(`  [OK] Postman Collection v2.1 (${res.postman.item.length} peticiones preparadas con CSRF Flow y Pre-request Handshake)`);
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
