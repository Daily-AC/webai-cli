import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NODE,
  NODE_NAMES,
  WORK_STATUS,
  WORK_STATUS_NAMES,
  ENDPOINTS,
  MAX_RIG_FACES,
  normalizeWork,
  outputsOf,
  glbTriangleCount,
} from '../src/providers/hunyuan/studio.js';

// ---- pipeline vocabulary ----

test('pipeline nodes match the studio bundle enum', () => {
  assert.deepEqual(NODE, {
    ALL: 0, CONCEPT: 1, GEOMETRY: 2, COMPONENT: 3, POLY: 4, UV: 5, TEXTURE: 6, RIGGING: 7, ANIMATION: 8,
  });
  assert.equal(NODE_NAMES[NODE.RIGGING], 'rigging');
  assert.equal(NODE_NAMES[NODE.ANIMATION], 'animation');
});

test('work status codes match the studio bundle enum', () => {
  assert.deepEqual(WORK_STATUS, { PENDING: 0, PROCESSING: 1, SUCCESS: 2, FAILED: 3, CANCEL: 4, DELETED: 5 });
  assert.equal(WORK_STATUS_NAMES[2], 'success');
});

test('endpoints keep the /game3d prefix the studio SPA uses', () => {
  assert.equal(ENDPOINTS.rig, '/game3d/bone_skinning/bone_skinning');
  assert.equal(ENDPOINTS.retarget, '/game3d/motion_retarget/motion_retarget');
  assert.equal(ENDPOINTS.worksList, '/game3d/general_info/get_works_list');
  assert.equal(MAX_RIG_FACES, 500_000);
});

// ---- work normalization ----

const RIG_WORK = {
  worksId: 'uid-0-abc',
  pipelineStatus: 2,
  worksPipeline: 7,
  nodeList: [7],
  workFlow: 'hunyuan-3d-auto-rigging-gamestudio',
  estimatedTimeCost: 30,
  dependonWorksInfo: { dependOnWorksId: '', conceptDesignWorksId: '' },
  inputInfo: '{"fbxUrl":"https://cos/in.fbx","isWithBone":false,"isKeepBone":false}',
  modelInfo: {
    errorCode: 0,
    errorMsg: '',
    boneSkinningRsp: {
      rigFbxUrl: 'https://cos/rigged.fbx',
      rigImageUrl: 'https://cos/rigged.png',
      isCharacter: true,
    },
  },
};

test('normalizeWork flattens status/node and parses the JSON-string inputInfo', () => {
  const work = normalizeWork(RIG_WORK);
  assert.equal(work.worksId, 'uid-0-abc');
  assert.equal(work.status, 2);
  assert.equal(work.statusName, 'success');
  assert.equal(work.node, 7);
  assert.equal(work.nodeName, 'rigging');
  assert.equal(work.inputInfo.fbxUrl, 'https://cos/in.fbx');
  assert.equal(work.inputInfo.isKeepBone, false);
  assert.equal(work.files.fbx, 'https://cos/rigged.fbx');
  assert.equal(work.files.image, 'https://cos/rigged.png');
});

test('normalizeWork leaves an unparseable inputInfo as the raw string', () => {
  const work = normalizeWork({ ...RIG_WORK, inputInfo: 'not json' });
  assert.equal(work.inputInfo, 'not json');
});

test('outputsOf reads the animation node response shape', () => {
  const files = outputsOf({
    modelInfo: {
      motionRetargetRsp: {
        fbxUrl: 'https://cos/animated.fbx',
        imageUrl: 'https://cos/cover.png',
        oriFbxUrl: 'https://cos/rigged.fbx',
      },
    },
  });
  assert.equal(files.fbx, 'https://cos/animated.fbx');
  assert.equal(files.image, 'https://cos/cover.png');
});

test('outputsOf returns nothing for a work that has produced no asset yet', () => {
  assert.deepEqual(outputsOf({ modelInfo: { errorCode: 0 } }), {});
});

// ---- glb preflight ----

function makeGlb(json) {
  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonText.length % 4)) % 4;
  const jsonChunk = Buffer.concat([jsonText, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // glTF
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // JSON
  return Buffer.concat([header, chunkHeader, jsonChunk]);
}

test('glbTriangleCount sums indexed triangle primitives', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webai-glb-'));
  const file = join(dir, 'model.glb');
  writeFileSync(
    file,
    makeGlb({
      accessors: [{ count: 300 }, { count: 90 }],
      meshes: [{ primitives: [{ indices: 0, attributes: { POSITION: 1 } }, { indices: 1, mode: 4 }] }],
    })
  );
  assert.equal(glbTriangleCount(file), 130);
});

test('glbTriangleCount falls back to POSITION when a primitive is not indexed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webai-glb-'));
  const file = join(dir, 'model.glb');
  writeFileSync(file, makeGlb({ accessors: [{ count: 60 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }] }));
  assert.equal(glbTriangleCount(file), 20);
});

test('glbTriangleCount skips non-triangle primitives and non-glb inputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'webai-glb-'));
  const lines = join(dir, 'lines.glb');
  writeFileSync(lines, makeGlb({ accessors: [{ count: 300 }], meshes: [{ primitives: [{ indices: 0, mode: 1 }] }] }));
  assert.equal(glbTriangleCount(lines), 0);

  const fbx = join(dir, 'model.fbx');
  writeFileSync(fbx, Buffer.from('not a glb'));
  assert.equal(glbTriangleCount(fbx), null);
});
