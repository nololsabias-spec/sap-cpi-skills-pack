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
            └── scenarioflows/
                └── integrationflow/
                    └── <IflowName>.iflw
```

### Cabeceras Clave de `META-INF/MANIFEST.MF` (IntegrationFlow)
- `SAP-BundleType: IntegrationFlow`
- `SAP-NodeType: IFLMAP`
- `SAP-RuntimeProfile: iflmap`
- `Bundle-SymbolicName: <IflowName>; singleton:=true`
- **Vinculación con Script Collection**:
  `Require-Capability: scriptcollection.<ScriptCollectionName>;resolution:=optional;bundleType:String="ScriptCollection";source:String="reference"`

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
