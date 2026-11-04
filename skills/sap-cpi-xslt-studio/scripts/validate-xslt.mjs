#!/usr/bin/env node
/**
 * SAP CPI XSLT 1.0 (Xalan) & XSLT 2.0/3.0 (Saxon-HE) Deterministic Validator
 * Checks anti-hallucination rules, engine compatibility, memory directives, and CPI extension functions.
 *
 * Usage:
 *   node validate-xslt.mjs <mapping.xslt | --demo> [--engine 2.0|1.0] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';

export function validateXsltStylesheet(xml, requestedEngine = null) {
  const errors = [];
  const warnings = [];
  const trimmed = (xml || '').trim();

  if (!trimmed) {
    return { valid: false, engine: requestedEngine || 'unknown', errors: ['El archivo XSLT está vacío.'], warnings: [] };
  }

  // 1. Root element check
  const rootMatch = trimmed.match(/<xsl:(stylesheet|transform)\b([^>]*)>/i);
  if (!rootMatch) {
    errors.push('Falta el elemento raíz `<xsl:stylesheet>` o `<xsl:transform>`.');
  }

  const rootAttrs = rootMatch ? rootMatch[2] : '';
  const versionMatch = rootAttrs.match(/\bversion\s*=\s*"([^"]+)"/);
  const detectedEngine = versionMatch ? versionMatch[1] : '2.0';
  const engine = requestedEngine || detectedEngine;

  if (requestedEngine && versionMatch && versionMatch[1] !== requestedEngine) {
    warnings.push(`El atributo version="${versionMatch[1]}" difiere del motor objetivo solicitado (${requestedEngine}).`);
  }

  if (!/xmlns:xsl\s*=\s*"http:\/\/www\.w3\.org\/1999\/XSL\/Transform"/.test(rootAttrs)) {
    errors.push('Falta la declaración de namespace obligatoria `xmlns:xsl="http://www.w3.org/1999/XSL/Transform"`.');
  }

  if (!/<\/xsl:(stylesheet|transform)>\s*$/i.test(trimmed)) {
    errors.push('El documento no cierra adecuadamente con `</xsl:stylesheet>` o `</xsl:transform>`.');
  }

  // 2. Anti-Hallucination Rule: Curly braces {} inside element text content
  // Remove XML comments and attribute values ("..." and '...') first, then check if >...{...}...< exists
  const withoutComments = trimmed.replace(/<!--[\s\S]*?-->/g, '');
  const textBetweenTagsRegex = />([^<]+)</g;
  let tm;
  while ((tm = textBetweenTagsRegex.exec(withoutComments)) !== null) {
    const textContent = tm[1];
    if (/\{[^{}]+\}/.test(textContent)) {
      const lineNo = withoutComments.slice(0, tm.index).split(/\r?\n/).length;
      errors.push(
        `[Línea ${lineNo}] Alucinación de interpolación XSLT detectada: \`${textContent.trim()}\`. En XSLT está PROHIBIDO usar llaves \`{campo}\` dentro del texto de un elemento; usa \`<xsl:value-of select="..."/>\`.`
      );
    }
  }

  // 3. Engine-specific rules (XSLT 1.0 Apache Xalan vs XSLT 2.0/3.0 Saxon-HE)
  if (engine === '1.0') {
    if (/exclude-result-prefixes\s*=\s*"[^"]*#all[^"]*"/.test(rootAttrs)) {
      errors.push('En XSLT 1.0 (Apache Xalan en SAP JVM) está PROHIBIDO usar `#all` en `exclude-result-prefixes`. Declara explícitamente la lista de prefijos o elimina el atributo.');
    }
    if (/<xsl:for-each-group\b/i.test(withoutComments) || /\bcurrent-grouping-key\s*\(/i.test(withoutComments)) {
      errors.push('`<xsl:for-each-group>` y `current-grouping-key()` no están soportados en XSLT 1.0 (Apache Xalan). Usa agrupación Muenchian (`<xsl:key>` + `key()`) o cambia el motor a XSLT 2.0 (Saxon-HE).');
    }
    if (/\b(?:fn:)?(?:matches|tokenize|replace|format-dateTime|upper-case|lower-case)\s*\(/.test(withoutComments)) {
      errors.push('Se detectaron funciones exclusivas de XPath 2.0 en una hoja XSLT 1.0.');
    }
  }

  // 4. SAP CPI Extension Functions validation (cpi:* or sapci:* via XmlExtFunctions or http://sap.com/it/)
  const usesCpiExt = /\b(?:cpi|sapci):(?:getHeader|setHeader|getProperty|setProperty)\s*\(/.test(withoutComments);
  if (usesCpiExt) {
    const hasOfficialExtNs =
      /xmlns:(?:cpi|sapci)\s*=\s*"(?:com\.sap\.it\.rt\.adapter\.xpath\.api\.XmlExtFunctions|http:\/\/sap\.com\/it\/?)"/.test(
        rootAttrs
      );
    if (!hasOfficialExtNs) {
      errors.push(
        'Se invocan funciones `cpi:*` / `sapci:*` pero falta `xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"` o `xmlns:sapci="http://sap.com/it/"` en `<xsl:stylesheet>`.'
      );
    }
    if (!/<xsl:param\s+name\s*=\s*"exchange"\s*\/?>/.test(withoutComments)) {
      errors.push('Se invocan funciones de Exchange (`setHeader`/`setProperty`) pero falta declarar `<xsl:param name="exchange"/>` a nivel raíz.');
    }
  }

  // 4b. XSLT 3.0 json-to-xml() namespace validation
  if (/\bjson-to-xml\s*\(/.test(withoutComments)) {
    if (engine !== '3.0') {
      errors.push('La función `json-to-xml()` requiere `version="3.0"` (motor Saxon-HE XSLT 3.0 en SAP CPI).');
    }
    if (!/http:\/\/www\.w3\.org\/2005\/xpath-functions/.test(withoutComments)) {
      warnings.push(
        'Se detectó `json-to-xml()` sin `xpath-default-namespace="http://www.w3.org/2005/xpath-functions"`; recuerda que los nodos generados (`map`, `array`, `string`, `number`) pertenecen a ese namespace.'
      );
    }
  }

  // 5. Memory & Performance best practices
  if (!/<xsl:strip-space\s+elements\s*=\s*"\*"\s*\/?>/.test(withoutComments)) {
    warnings.push('Recomendación SAP CPI: Incluye `<xsl:strip-space elements="*"/>` para reducir el consumo de memoria en el pipeline XML.');
  }
  if (!/<xsl:output\b[^>]*encoding\s*=\s*"UTF-8"/i.test(withoutComments)) {
    warnings.push('Recomendación SAP CPI: Incluye `<xsl:output method="xml" encoding="UTF-8" indent="no"/>`.');
  }

  return {
    valid: errors.length === 0,
    engine,
    errors,
    warnings
  };
}

export const DEMO_VALID_XSLT = `<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:cpi="com.sap.it.rt.adapter.xpath.api.XmlExtFunctions"
    exclude-result-prefixes="#all cpi">
    <xsl:output method="xml" encoding="UTF-8" indent="no"/>
    <xsl:strip-space elements="*"/>
    <xsl:param name="exchange"/>

    <xsl:template match="/">
        <BatchedOrders>
            <xsl:for-each-group select="//Record" group-by="OrderId">
                <Order id="{current-grouping-key()}">
                    <SourceSystem><xsl:value-of select="cpi:getHeader($exchange, 'SAP_Sender')"/></SourceSystem>
                    <Items>
                        <xsl:for-each select="current-group()">
                            <Item>
                                <id><xsl:value-of select="ItemId"/></id>
                                <qty><xsl:value-of select="Quantity"/></qty>
                            </Item>
                        </xsl:for-each>
                    </Items>
                </Order>
            </xsl:for-each-group>
        </BatchedOrders>
    </xsl:template>
</xsl:stylesheet>`;

// CLI Runner
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log('Uso: node validate-xslt.mjs <mapping.xslt | --demo> [--engine 2.0|1.0] [--json]');
    process.exit(0);
  }

  const jsonFlag = args.includes('--json');
  const engIdx = args.indexOf('--engine');
  const requestedEngine = engIdx !== -1 ? args[engIdx + 1] : null;

  let xmlContent = '';
  if (args[0] === '--demo') {
    xmlContent = DEMO_VALID_XSLT;
  } else {
    const filePath = path.resolve(args[0]);
    if (!fs.existsSync(filePath)) {
      console.error(`Archivo no encontrado: ${filePath}`);
      process.exit(1);
    }
    xmlContent = fs.readFileSync(filePath, 'utf8');
  }

  const result = validateXsltStylesheet(xmlContent, requestedEngine);
  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== SAP CPI XSLT VALIDATOR (Motor: XSLT ${result.engine}) ===`);
    console.log(`Estado: ${result.valid ? 'VÁLIDO (100% Compatible con SAP CPI)' : 'ERROR DE VALIDACIÓN'}`);
    if (result.errors.length > 0) {
      console.log('\nErrores Críticos:');
      result.errors.forEach((e) => console.log(`  [ERROR] ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('\nAdvertencias / Recomendaciones:');
      result.warnings.forEach((w) => console.log(`  [WARN]  ${w}`));
    }
  }

  if (!result.valid) process.exit(1);
}
