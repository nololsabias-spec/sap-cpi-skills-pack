# Especificación de Bundles OSGi para SAP Cloud Integration (iFlow & Script Collection)

## 1. Estructura Interna del ZIP de un `IntegrationFlow`
```text
<IflowName>.zip
├── .project
├── metainfo.prop
├── META-INF/
│   └── MANIFEST.MF
└── src/
    └── main/
        └── resources/
            ├── parameters.prop
            ├── parameters.propdef
            ├── mapping/
            │   ├── *.xslt
            │   └── *.mmap
            ├── xsd/
            │   └── *.xsd
            └── scenarioflows/
                └── integrationflow/
                    └── <IflowName>.iflw
```

### Cabeceras Clave de `META-INF/MANIFEST.MF` (IntegrationFlow)
- `SAP-BundleType: IntegrationFlow`
- `SAP-NodeType: IFLMAP`
- `SAP-RuntimeProfile: iflmap`
- `Bundle-SymbolicName: <IflowName>` (o `<IflowName>; singleton:=true`)
- **Vinculación con una o varias Script Collections** (separadas por coma si el iFlow consume scripts de múltiples colecciones, p. ej. una colección compartida y una específica):
  `Require-Capability: scriptcollection.<SharedSC>;resolution:=optional;bundleType:String="ScriptCollection";source:String="reference",scriptcollection.<DomainSC>;resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"`

---

## 2. Estructura Interna del ZIP de un `ScriptCollection`
```text
<ScriptCollectionName>.zip
├── .project
├── metainfo.prop
├── META-INF/
│   └── MANIFEST.MF
└── src/
    └── main/
        └── resources/
            └── script/
                ├── Script1.groovy
                └── Script2.groovy
```

### Cabeceras Clave de `META-INF/MANIFEST.MF` (ScriptCollection)
- `SAP-BundleType: ScriptCollection`
- `SAP-NodeType: IFLMAP`
- `Import-Package: org.osgi.framework`
- `Provide-Capability: scriptcollection.<ScriptCollectionName>;version:Version="1.0.0"`

---

## 3. Reglas Críticas de Empaquetado ZIP y `MANIFEST.MF` (Prevención del Error `The project must contain a valid manifest file`)

El importador de artefactos de SAP Cloud Integration (`JarInputStream` / validador OSGi de SAP BTP) aplica validaciones estrictas sobre la estructura interna del archivo `.zip`. Cualquier incumplimiento provoca el error:
> `Upload the artifact failed. The project must contain a valid manifest file`

### 3.1. Prohibición de Carpeta Raíz Intermedia (Root-Level Entries)
- **Regla obligatoria**: `.project`, `metainfo.prop`, `META-INF/MANIFEST.MF` y `src/main/resources/...` deben ubicarse **directamente en la raíz del archivo `.zip`**.
- **Anti-patrón**: Comprimir la carpeta contenedora generando rutas como `Mi_iFlow_v1/META-INF/MANIFEST.MF` o `Mi_iFlow_v1/.project`. Cuando `META-INF/MANIFEST.MF` está dentro de una subcarpeta, SAP CPI no lo encuentra en la raíz y rechaza el paquete.
- **Automatización**: Tanto `build-cpi-package.mjs` como `clone-iflow-bundle.mjs` (`stripRootFolderPrefix`) eliminan automáticamente cualquier prefijo de carpeta raíz heredado y ordenan `.project` y `META-INF/MANIFEST.MF` como las primeras entradas del flujo ZIP.

### 3.2. Límite de 72 Bytes UTF-8 por Línea en `MANIFEST.MF`
- **Regla obligatoria**: Según la especificación JAR/OSGi (`java.util.jar.Manifest`), ninguna línea física de `META-INF/MANIFEST.MF` puede superar los **72 bytes en UTF-8** (sin contar `\r\n`).
- **Plegado de líneas (Line Wrapping)**: Las cabeceras largas (como `Import-Package`, `Provide-Capability`, `Require-Capability` o `Bundle-SymbolicName`) deben partirse con salto de línea `\r\n` seguido de **un espacio en blanco simple (` `)** al inicio de la línea de continuación, y el archivo debe finalizar siempre con una línea en blanco (`\r\n\r\n`).

### 3.3. Exclusión de Basura del Sistema Operativo y Subida Individual
- **Sin archivos ocultos de SO**: Nunca incluir `__MACOSX/`, `.DS_Store` ni `Thumbs.db` dentro del `.zip`.
- **Subida individual por artefacto**: En la interfaz web de SAP CPI (*Design -> Package -> Add*), cada `.zip` de artefacto (`<ScriptCollection>.zip` en *Add -> Script Collection* y cada `<Iflow>.zip` en *Add -> Integration Flow*) debe subirse de forma individual, nunca subiendo un `.zip` contenedor que agrupe varios `.zip` dentro.
