#!/usr/bin/env node
// Self-test for the script identity and compilation rules of validate-groovy.mjs (LL-039).
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

console.log(JSON.stringify({
  pastedFlagged: pasted.includes('SCRIPT_NAME_MISMATCH'),
  ownFileClean: !ownFile.includes('SCRIPT_NAME_MISMATCH') && !ownFile.includes('STRAY_COMMENT_CLOSE'),
  duplicatedCloseFlagged: duplicatedClose.includes('STRAY_COMMENT_CLOSE'),
  legacyHeaderFlagged: legacyHeader.includes('SCRIPT_NAME_MISMATCH')
}));
