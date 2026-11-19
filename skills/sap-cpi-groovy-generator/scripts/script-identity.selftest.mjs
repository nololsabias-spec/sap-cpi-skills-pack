#!/usr/bin/env node
// Self-test for the script identity and compilation rules of validate-groovy.mjs (LL-039, LL-040).
// Prints one JSON object that verify-all.mjs checks.
import { lintGroovyScript } from './validate-groovy.mjs';

const body = (name) => `/**
 * Builds the outbound payload.
 *
 * Script step: Groovy 2.4 (Script step 1.x) · API v1
 */
import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    try {
        message.setProperty('Built', 'true')
        return message
    } catch (Exception e) {
        throw new Exception('CPI-ERR: ${name} failed - ' + e.getMessage(), e)
    }
}
`;

const ids = (code, file) => lintGroovyScript(code, file, { groovyVersion: '2.4' }).findings.map((f) => f.ruleId);

// Code of BuildPayload pasted into another script of the same collection
const pasted = ids(body('BuildPayload'), 'BuildQueueMessage.groovy');
// Same code in its own file
const ownFile = ids(body('BuildPayload'), 'BuildPayload.groovy');
// Duplicated end of the header comment
const duplicatedClose = ids(body('BuildPayload').replace(' */\n', ' */\n */\n'), 'BuildPayload.groovy');
// Free-form legacy header naming the file
const legacyHeader = ids('/*\n * BuildPayload.groovy - iFlow Orders\n */\n' + body('BuildPayload').split('*/\n')[1], 'BuildQueueMessage.groovy');

// Block pasted twice and the line that declared `number` replaced (LL-040)
const good = `import com.sap.gateway.ip.core.customdev.util.Message

def Message processData(Message message) {
    def prop = { String n -> message.getProperty(n) }
    List attList = []
    String number = 'TASK0001'
    String bucket = (prop('S3Bucket') ?: '').toString().trim()
    if (attList && !bucket) {
        throw new IllegalStateException('CPI-ERR: missing property S3Bucket')
    }
    def uris = attList.collect { a -> 's3://' + bucket + '/' + number + '/' + a }
    for (String u : uris) { message.setProperty('Last', u) }
    for (String u : uris) { message.setProperty('First', u) }
    boolean ok = (prop('x') ?: '').toString().replaceAll(/[^0-9A-Za-z]/, '') != ''
    def result = attList as List
    int limit = 10
    message.setProperty('Uris', uris.join(',') + limit + ok + result)
    return message
}
`;
const block = "    String bucket = (prop('S3Bucket') ?: '').toString().trim()\n    if (attList && !bucket) {\n        throw new IllegalStateException('CPI-ERR: missing property S3Bucket')\n    }\n";
const pastedTwice = good.replace("    String number = 'TASK0001'\n", '').replace(block, block + block);
const goodIds = ids(good, 'Selftest.groovy');
const pastedIds = ids(pastedTwice, 'Selftest.groovy');

console.log(JSON.stringify({
  pasteDuplicateFlagged: pastedIds.includes('DUPLICATE_LOCAL_VARIABLE'),
  pasteMissingDeclFlagged: pastedIds.includes('UNDECLARED_VARIABLE_READ'),
  goodVarsClean: !goodIds.includes('DUPLICATE_LOCAL_VARIABLE') && !goodIds.includes('UNDECLARED_VARIABLE_READ'),
  pastedFlagged: pasted.includes('SCRIPT_NAME_MISMATCH'),
  ownFileClean: !ownFile.includes('SCRIPT_NAME_MISMATCH') && !ownFile.includes('STRAY_COMMENT_CLOSE'),
  duplicatedCloseFlagged: duplicatedClose.includes('STRAY_COMMENT_CLOSE'),
  legacyHeaderFlagged: legacyHeader.includes('SCRIPT_NAME_MISMATCH')
}));
