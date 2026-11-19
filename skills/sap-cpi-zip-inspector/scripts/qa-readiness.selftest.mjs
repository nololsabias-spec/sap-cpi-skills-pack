#!/usr/bin/env node
// Self-test for the environment-readiness advisories of inspect-iflow-zip.mjs (LL-041):
// IFLW-011 unused parameters, IFLW-012 bare host in a channel, IFLW-013 secret header never deleted,
// MANIFEST-NAME-ID name different from the artifact ID. Prints one JSON object that verify-all.mjs checks.
import { inspectBundle } from './inspect-iflow-zip.mjs';
import { createZipBuffer } from '../../../shared/zip-utils.mjs';

const manifest = (name, id, type) =>
  `Manifest-Version: 1.0\r\nBundle-ManifestVersion: 2\r\nBundle-Name: ${name}\r\nBundle-SymbolicName: ${id}\r\nBundle-Version: 1.0.0\r\nSAP-BundleType: ${type}\r\n\r\n`;

const row = (action, name, value) =>
  `&lt;row&gt;&lt;cell id='Action'&gt;${action}&lt;/cell&gt;&lt;cell id='Type'&gt;constant&lt;/cell&gt;&lt;cell id='Value'&gt;${value}&lt;/cell&gt;&lt;cell id='Default'&gt;&lt;/cell&gt;&lt;cell id='Name'&gt;${name}&lt;/cell&gt;&lt;cell id='Datatype'&gt;&lt;/cell&gt;&lt;/row&gt;`;

const iflw = (deleteHeader) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ifl="http:///com.sap.ifl.model/Ifl.xsd">
  <bpmn2:collaboration id="Collaboration_1">
    <bpmn2:messageFlow id="MessageFlow_1" name="Storage" sourceRef="ServiceTask_1" targetRef="Participant_2">
      <bpmn2:extensionElements>
        <ifl:property><key>ComponentType</key><value>AmazonWebServices</value></ifl:property>
        <ifl:property><key>host</key><value>storage.eu-west-1.example.com</value></ifl:property>
        <ifl:property><key>bucketName</key><value>{{Bucket}}</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
    <bpmn2:messageFlow id="MessageFlow_2" name="Api" sourceRef="ServiceTask_2" targetRef="Participant_3">
      <bpmn2:extensionElements>
        <ifl:property><key>ComponentType</key><value>HTTP</value></ifl:property>
        <ifl:property><key>httpAddressWithoutQuery</key><value>{{ApiEndpoint}}/v1</value></ifl:property>
        <ifl:property><key>allowedRequestHeaders</key><value>X-Api-Key|Content-Type</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:messageFlow>
  </bpmn2:collaboration>
  <bpmn2:process id="Process_1" name="Integration Process">
    <bpmn2:callActivity id="CallActivity_1" name="Clean Headers">
      <bpmn2:extensionElements>
        <ifl:property><key>headerTable</key><value>${deleteHeader ? row('Delete', 'X-Api-Key', '') : ''}</value></ifl:property>
      </bpmn2:extensionElements>
    </bpmn2:callActivity>
  </bpmn2:process>
</bpmn2:definitions>
`;

const bundle = (deleteHeader, props) => createZipBuffer([
  { path: 'META-INF/MANIFEST.MF', content: manifest('Orders_Flow', 'Orders_Flow', 'IntegrationFlow') },
  { path: 'src/main/resources/scenarioflows/integrationflow/Orders_Flow.iflw', content: iflw(deleteHeader) },
  { path: 'src/main/resources/parameters.prop', content: props }
], { date: new Date(2020, 0, 1) });

const vm = createZipBuffer([
  { path: 'META-INF/MANIFEST.MF', content: manifest('VM_Display_Name', 'VM_Other_Id', 'ValueMapping') },
  { path: 'value_mapping.xml', content: '<vm version="2.0"/>' }
], { date: new Date(2020, 0, 1) });

const bad = inspectBundle(bundle(false, 'Bucket=b\nApiEndpoint=e\nOldTimer=x\n'), null, { sourceName: 'bad.zip' }).heuristics;
const good = inspectBundle(bundle(true, 'Bucket=b\nApiEndpoint=e\n'), null, { sourceName: 'good.zip' }).heuristics;
const vmReport = inspectBundle(vm, null, { sourceName: 'vm.zip' }).heuristics;

console.log(JSON.stringify({
  unusedParamFlagged: bad.unusedParameters.includes('OldTimer') && bad.unusedParameters.length === 1,
  bareHostFlagged: bad.bareHostsNotExternalized.length === 1 && bad.bareHostsNotExternalized[0].key === 'host',
  secretHeaderFlagged: bad.secretHeadersNotDeleted.some((s) => s.header === 'X-Api-Key'),
  deletedHeaderClean: good.secretHeadersNotDeleted.length === 0 && good.unusedParameters.length === 0,
  nameIdFlagged: Boolean(vmReport.nameIdMismatch && vmReport.nameIdMismatch.id === 'VM_Other_Id'),
  sameNameClean: good.nameIdMismatch === null
}));
