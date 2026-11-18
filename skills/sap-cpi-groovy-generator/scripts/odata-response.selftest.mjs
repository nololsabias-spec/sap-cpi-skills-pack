#!/usr/bin/env node
// Self-test for the OData response rules of validate-groovy.mjs (LL-030, LL-034).
// Prints one JSON object that verify-all.mjs checks.
import { lintGroovyScript } from './validate-groovy.mjs';

const header = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    def reader = message.getBody(java.io.Reader)
    try {
        def body = reader.text
`;
const footer = `        message.setProperty("IsFinalError", (!ok).toString())
    } catch (Exception e) {
        throw new Exception("CPI-ERR: " + e.getMessage(), e)
    } finally {
        reader.close()
    }
    return message
}
`;

const legacy = header + `        boolean ok = body.contains("HTTP/1.1 200") || body.contains("<statusCode>201</statusCode>")
        def messageLog = message.getMessageLog()
        messageLog?.addCustomHeaderProperty("Status", ok ? "OK" : "KO")
` + footer;

const fixed = header + `        List codes = []
        (body =~ /<statusCode>\\s*(\\d{3})\\s*<\\/statusCode>/).each { m -> codes << m[1] }
        boolean ok = !codes.isEmpty() && codes.every { it.startsWith("2") }
        def messageLog = messageLogFactory?.getMessageLog(message)
        messageLog?.addCustomHeaderProperty("Status", ok ? "OK" : "KO")
` + footer;

const ids = (code) => lintGroovyScript(code, 'Selftest.groovy', { groovyVersion: '2.4' }).findings.map((f) => f.ruleId);
const legacyIds = ids(legacy);
const fixedIds = ids(fixed);

console.log(JSON.stringify({
  legacyFlagsGetMessageLog: legacyIds.includes('MESSAGE_GETMESSAGELOG'),
  legacyFlagsOnly200: legacyIds.includes('ODATA_SUCCESS_ONLY_200_201'),
  fixedClean: !fixedIds.includes('MESSAGE_GETMESSAGELOG') && !fixedIds.includes('ODATA_SUCCESS_ONLY_200_201')
}));
