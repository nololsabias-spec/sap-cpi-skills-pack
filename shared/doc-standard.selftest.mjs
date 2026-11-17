#!/usr/bin/env node
/**
 * Self-test of the comment-language rule (comments must always be written in English).
 * Prints a JSON object consumed by verify-all.mjs.
 */
import { lintGroovyDocs, looksSpanish } from './doc-standard.mjs';

const spanish = '/**\n * Calcula el total del pedido.\n *\n * Motivo: el redondeo no se puede hacer en un paso estándar.\n */\n// Se recorta el valor para que no falle con null\nclass A {}\n';
const english = '/**\n * Calculates the order total.\n *\n * Why: rounding cannot be done in a standard step.\n */\n// The value is truncated so that it does not fail on null\nclass A {}\n';
const ruleIds = (code) => lintGroovyDocs(code, { groovyVersion: '2.4' }).map((f) => f.ruleId);

console.log(JSON.stringify({
  spanishFlagged: ruleIds(spanish).includes('DOC_COMMENT_LANGUAGE'),
  englishClean: !ruleIds(english).includes('DOC_COMMENT_LANGUAGE'),
  spanishDetected: looksSpanish('Lee el body y devuelve el mensaje con la cabecera'),
  englishDetected: !looksSpanish('Reads the body and returns the message with the header')
}));
