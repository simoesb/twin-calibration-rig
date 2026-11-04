// Demo twin for the evidence-tracking use case, seeded into an AAS server (BaSyx).
//
//   node demo-twin.mjs seed      [aasBase]   — create the twin (removes a previous copy first)
//   node demo-twin.mjs simulate  [aasBase]   — drive the conveyor position live (Ctrl+C to stop)
//   node demo-twin.mjs cleanup   [aasBase]   — remove everything the seed created
//   node demo-twin.mjs recording <dir>       — write the conveyor loop as an MQTT Playback recording
//                                              (<dir>/DemoCell.jsonl + DemoCell.json): the BaSyx
//                                              element-update events of Operation.Position, so a
//                                              replay drives the twin without this script
//
// aasBase defaults to http://localhost:8050/aas-env (the platform's BaSyx, same origin).
//
// The twin ("DemoCell"):
//   - root shell: IDTA Hierarchical Structures BoM naming Conveyor + Bracket, and an
//     IDTA Models3D with the cell model (assets/out/democell.glb from assets/build-assets.mjs:
//     floor, conveyor, carrier, workstation);
//   - Conveyor shell: Operation.Position (m, live — an IDTA AIMC relation maps the
//     conveyor interface into it) and a SceneMapping that slides the model's Carrier;
//   - Bracket shell: the physical part with NO 3D model, whose TechnicalData declares
//     Width / Height / Depth / HoleSpacing — the reference for scaling and checking a
//     reconstruction.
// All ids are under urn:demo-twin: so cleanup only touches what seed created.

import fs from 'node:fs';

const BASE = (process.argv[3] ?? 'http://localhost:8050/aas-env').replace(/\/+$/, '');
const NS = 'urn:demo-twin';
const b64 = (id) => Buffer.from(id, 'utf8').toString('base64url');
const sem = (v) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: v }] });
const ref = (id) => ({ type: 'ModelReference', keys: [{ type: 'Submodel', value: id }] });
const elRef = (sm, ...path) => ({ type: 'ModelReference', keys: [{ type: 'Submodel', value: sm }, ...path.map((value) => ({ type: 'SubmodelElement', value }))] });
const prop = (idShort, value, valueType = 'xs:string', extra = {}) => ({ idShort, modelType: 'Property', valueType, value: String(value), ...extra });
const metres = (idShort, value) => prop(idShort, value, 'xs:double', { qualifiers: [{ type: 'unit', valueType: 'xs:string', value: 'm' }] });
const SC = 'https://www.vicomtech.org/lab/cd/SceneMapping/1/0';

const ID = {
  root: `${NS}:aas:cell`, conveyor: `${NS}:aas:conveyor`, bracket: `${NS}:aas:bracket`,
  bom: `${NS}:sm:bom`, models3d: `${NS}:sm:models3d`,
  convOp: `${NS}:sm:conveyor-operation`, convAimc: `${NS}:sm:conveyor-aimc`, convMap: `${NS}:sm:conveyor-scenemapping`,
  convTech: `${NS}:sm:conveyor-technicaldata`, brTech: `${NS}:sm:bracket-technicaldata`, brPlate: `${NS}:sm:bracket-nameplate`,
};
// Platform-owned submodels the twin tools create on the root shell.
const AUTHORED = ['AuthoredModels3D', 'AuthoredSceneMapping', 'DecisionLog'].map((s) => `${ID.root}/submodels/${s}`);

const MODEL = new URL('./assets/out/democell.glb', import.meta.url);
const MODEL_TYPE = 'model/gltf-binary';

const submodels = [
  { id: ID.bom, idShort: 'HierarchicalStructures', semanticId: sem('https://admin-shell.io/idta/HierarchicalStructures/1/0/Submodel'),
    submodelElements: [{ idShort: 'EntryNode', modelType: 'Entity', entityType: 'SelfManagedEntity', globalAssetId: `${NS}:asset:cell`,
      semanticId: sem('https://admin-shell.io/idta/HierarchicalStructures/1/0/EntryNode'),
      statements: [
        { idShort: 'Conveyor', modelType: 'Entity', entityType: 'SelfManagedEntity', globalAssetId: `${NS}:asset:conveyor` },
        { idShort: 'Bracket', modelType: 'Entity', entityType: 'SelfManagedEntity', globalAssetId: `${NS}:asset:bracket` },
      ] }] },
  { id: ID.models3d, idShort: 'Models3D', semanticId: sem('https://admin-shell.io/idta/Models3D/1/0'),
    submodelElements: [{ idShort: 'Model3D', modelType: 'SubmodelElementCollection', semanticId: sem('https://admin-shell.io/idta/Models3D/Model3D/1/0'), value: [
      { idShort: 'File', modelType: 'SubmodelElementCollection', semanticId: sem('https://admin-shell.io/idta/Models3D/Model3D/File/1/0'), value: [
        { idShort: 'FileVersion', modelType: 'SubmodelElementCollection', value: [
          { idShort: 'FileVersion01', modelType: 'SubmodelElementCollection', value: [
            { idShort: 'DigitalFile', modelType: 'File', contentType: MODEL_TYPE, value: 'democell.glb' }] }] }] }] }] },
  { id: ID.convOp, idShort: 'Operation', submodelElements: [metres('Position', 0), prop('Running', 'true', 'xs:boolean'), prop('Speed', 0.2, 'xs:double')] },
  { id: ID.convTech, idShort: 'TechnicalData', semanticId: sem('https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/1'),
    submodelElements: [metres('BeltLength', 2.0), metres('BeltWidth', 0.4), metres('TravelRange', 1.6)] },
  { id: ID.convAimc, idShort: 'AssetInterfacesMappingConfiguration', semanticId: sem('https://admin-shell.io/idta/AssetInterfacesMappingConfiguration/1/0/Submodel'),
    submodelElements: [{ idShort: 'MappingConfigurations', modelType: 'SubmodelElementCollection', value: [
      { idShort: 'PositionRelation', modelType: 'RelationshipElement', first: elRef(`${NS}:sm:conveyor-aid`, 'InterfaceMQTT', 'Position'), second: elRef(ID.convOp, 'Position') }] }] },
  { id: ID.convMap, idShort: 'SceneMapping', semanticId: sem(`${SC}/Submodel`),
    submodelElements: [{ idShort: 'MeshBinding_0', modelType: 'SubmodelElementCollection', semanticId: sem(`${SC}/MeshBinding`), value: [
      { ...prop('MeshPath', '/root/Carrier'), semanticId: sem(`${SC}/MeshBinding/MeshPath`) },
      { idShort: 'GeometryBinding', modelType: 'SubmodelElementCollection', semanticId: sem(`${SC}/GeometryBinding`), value: [
        { idShort: 'Binding', modelType: 'SubmodelElementCollection', semanticId: sem(`${SC}/Binding`), value: [
          { ...prop('Property', 'position'), semanticId: sem(`${SC}/Binding/Property`) },
          { ...prop('Axis', 'x'), semanticId: sem(`${SC}/Binding/Axis`) },
          { idShort: 'Source', modelType: 'ReferenceElement', semanticId: sem(`${SC}/Binding/Source`), value: elRef(ID.convOp, 'Position') }] }] }] }] },
  { id: ID.brPlate, idShort: 'Nameplate', semanticId: sem('https://admin-shell.io/zvei/nameplate/2/0/Nameplate'),
    submodelElements: [prop('ManufacturerProductDesignation', 'Mounting bracket MB-120'), prop('SerialNumber', 'MB120-0042')] },
  { id: ID.brTech, idShort: 'TechnicalData', semanticId: sem('https://admin-shell.io/ZVEI/TechnicalData/Submodel/1/1'),
    submodelElements: [metres('Width', 0.12), metres('Height', 0.08), metres('Depth', 0.05), metres('HoleSpacing', 0.06), prop('HoleCount', 2, 'xs:integer')] },
].map((s) => ({ modelType: 'Submodel', kind: 'Instance', ...s }));

const shells = [
  { id: ID.root, idShort: 'DemoCell', assetInformation: { assetKind: 'Instance', globalAssetId: `${NS}:asset:cell` }, submodels: [ref(ID.bom), ref(ID.models3d)] },
  { id: ID.conveyor, idShort: 'Conveyor', assetInformation: { assetKind: 'Instance', globalAssetId: `${NS}:asset:conveyor` }, submodels: [ref(ID.convOp), ref(ID.convTech), ref(ID.convAimc), ref(ID.convMap)] },
  { id: ID.bracket, idShort: 'Bracket', assetInformation: { assetKind: 'Instance', globalAssetId: `${NS}:asset:bracket` }, submodels: [ref(ID.brPlate), ref(ID.brTech)] },
].map((s) => ({ modelType: 'AssetAdministrationShell', ...s }));

async function req(method, path, body) {
  const r = await fetch(`${BASE}${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok && r.status !== 404) throw new Error(`${method} ${path} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status;
}

async function cleanup(quiet) {
  for (const id of [...Object.values(ID).filter((id) => id.includes(':sm:')), ...AUTHORED]) await req('DELETE', `/submodels/${b64(id)}`);
  for (const s of shells) await req('DELETE', `/shells/${b64(s.id)}`);
  if (!quiet) console.log('demo twin removed');
}

async function seed() {
  await cleanup(true);
  for (const sm of submodels) await req('POST', '/submodels', sm);
  for (const sh of shells) await req('POST', '/shells', sh);
  const form = new FormData();
  if (!fs.existsSync(MODEL)) throw new Error('assets/out/democell.glb is missing — run: cd assets && npm install && npm run build');
  form.append('file', new Blob([fs.readFileSync(MODEL)], { type: MODEL_TYPE }), 'democell.glb');
  form.append('fileName', 'democell.glb');
  const up = await fetch(`${BASE}/submodels/${b64(ID.models3d)}/submodel-elements/${encodeURIComponent('Model3D.File.FileVersion.FileVersion01.DigitalFile')}/attachment`, { method: 'PUT', body: form });
  console.log(`demo twin seeded at ${BASE}: ${shells.length} shells, ${submodels.length} submodels, model upload ${up.status}`);
}

async function simulate() {
  console.log('driving Conveyor/Operation/Position (0 → 1.6 m and back); Ctrl+C to stop');
  for (let t = 0; ; t += 0.5) {
    const pos = (0.8 * (1 - Math.cos((t / 8) * Math.PI))).toFixed(3); // 0..1.6 m, 16 s period
    await fetch(`${BASE}/submodels/${b64(ID.convOp)}/submodel-elements/Position/$value`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pos),
    }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
  }
}

// One conveyor cycle as the cell runs it (the process flow of the DemoCell scene): the carrier
// travels to the end stop, waits while the robot picks, returns empty and pauses.
const CYCLE = [
  { until: 8, from: 0, to: 1.6 },     // carrier arrives (eased)
  { until: 14, from: 1.6, to: 1.6 },  // robot picks at the end stop
  { until: 18, from: 1.6, to: 0 },    // carrier returns
  { until: 20, from: 0, to: 0 },      // pause before the next carrier
];
const RECORDING_HZ = 20;

function recording(dir) {
  if (!dir) throw new Error('usage: node demo-twin.mjs recording <dir>');
  const topic = `sm-repository/sm-repo/submodels/${b64(ID.convOp)}/submodelElements/Position/updated`;
  const lines = [];
  let start = 0;
  for (const seg of CYCLE) {
    for (let t = start; t < seg.until - 1e-9; t += 1 / RECORDING_HZ) {
      const u = (t - start) / (seg.until - start);
      const pos = seg.from + (seg.to - seg.from) * (1 - Math.cos(Math.PI * u)) / 2;
      const payload = JSON.stringify({ modelType: 'Property', value: pos.toFixed(4), valueType: 'xs:double', idShort: 'Position' }, null, 2);
      lines.push(JSON.stringify({ topic, payload, timestamp: Number(t.toFixed(3)) }));
    }
    start = seg.until;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/DemoCell.jsonl`, lines.join('\n') + '\n');
  fs.writeFileSync(`${dir}/DemoCell.json`, JSON.stringify({ topics: [topic] }));
  console.log(`recording written: ${dir}/DemoCell.jsonl (${lines.length} messages, ${CYCLE.at(-1).until} s loop)`);
}

const cmd = process.argv[2];
(cmd === 'seed' ? seed() : cmd === 'cleanup' ? cleanup(false) : cmd === 'simulate' ? simulate()
  : cmd === 'recording' ? Promise.resolve(recording(process.argv[3]))
  : Promise.reject(new Error('usage: node demo-twin.mjs seed|simulate|cleanup [aasBase] | recording <dir>')))
  .catch((e) => { console.error(e.message); process.exitCode = 1; });
