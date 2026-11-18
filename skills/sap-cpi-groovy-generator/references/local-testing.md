# Simulación local de scripts y Routers (Groovy 2.4)

Sirve para probar casos que el tenant no permite provocar (datos de prueba que faltan, bloqueos, respuestas 204 o 503) y para comprobar un cambio antes de desplegarlo. No sustituye a la prueba en el tenant: las respuestas de S/4 y del adaptador se escriben a mano con el formato real que devuelve el sistema.

## 1. Preparación

- `apt-get install groovy` instala Groovy 2.4.x, el mismo runtime que el paso Script 1.x.
- Trabaja sobre copias limpias (`sanitize-iflow-zip.mjs`) y pasa al runner la carpeta de scripts como argumento; no ejecutes nada desde dentro de la carpeta extraída.

## 2. `Message` simulado

Compílalo una vez (`groovyc -d classes Message.groovy`) y ejecuta el runner con `groovy -cp classes run.groovy <carpeta-scripts>`.

```groovy
package com.sap.gateway.ip.core.customdev.util
class Message {
    Object body
    Map<String, Object> props = [:]
    Map<String, Object> headers = [:]
    Object getBody(Class c) { if (body == null) return null; c == java.io.Reader ? new StringReader(body.toString()) : body.toString() }
    Object getBody() { body }
    void setBody(Object b) { body = b }
    Object getProperty(String k) { props[k] }
    void setProperty(String k, Object v) { props[k] = v }
    Map<String, Object> getHeaders() { headers }
    void setHeader(String k, Object v) { headers[k] = v }
}
```

Trampas conocidas:
- Como la clase define `getProperty(String)`, en Groovy `m.props` llama a `getProperty("props")` y devuelve `null`. En el runner usa `m.@props` (acceso directo al campo) y `m.setBody(...)`.
- `messageLogFactory` se pasa en el `Binding` del `GroovyShell`, como un `Expando` cuyo `getMessageLog` devuelve otro `Expando` con `addCustomHeaderProperty`.
- Si el script usa `org.slf4j.Logger`, añade un stub de `Logger` y `LoggerFactory` en el mismo `classes`.
- En el runner, las variables locales del script no son visibles desde métodos `def`: usa closures o `@Field`.

## 3. Runner

1. Construye el body y las properties de entrada como los deja el paso anterior del iFlow.
2. Ejecuta los scripts en el orden del iFlow (`shell.parse(new File(dir, 'X.groovy')).processData(m)`), sustituyendo cada llamada externa por la respuesta simulada.
3. Reproduce cada Router con sus condiciones **en el orden de la tabla**, con la ruta por defecto la última; así se detectan condiciones que se pisan.
4. Por caso, imprime la ruta, el número de mails que saldrían, el custom status, las properties clave y los custom headers del MPL.
5. Guarda la salida y compárala (`diff`) después de cada cambio: los casos que no deben cambiar tienen que dar exactamente lo mismo.

## 4. Casos que conviene tener siempre

Alta, modificación, sin cambios, elemento que falta, elemento que sobra, entradas repetidas, orden distinto en la respuesta, ceros a la izquierda, varias coincidencias, 204, 4xx de negocio, 423/503, mezcla de temporal y definitivo, respuesta vacía y respuesta sin hijos.
