import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topologicalSort, CycleError, deriveStepStates } from '../server/domain/dag.js';
import { evaluateApplicability, evaluateCondition } from '../server/domain/condition.js';

test('拓扑排序：合法 DAG 得到拓扑序', () => {
  const keys = ['S01', 'S02', 'S10', 'S20'];
  const edges = [['S01', 'S02'], ['S02', 'S10'], ['S10', 'S20']];
  const order = topologicalSort(keys, edges);
  assert.deepEqual(order, ['S01', 'S02', 'S10', 'S20']);
});

test('拓扑排序：存在环必须抛 CycleError（发布期强校验）', () => {
  const keys = ['A', 'B', 'C'];
  const edges = [['A', 'B'], ['B', 'C'], ['C', 'A']];
  assert.throws(() => topologicalSort(keys, edges), CycleError);
});

test('拓扑排序：自环通过 CHECK 约束/缺失引用报错', () => {
  assert.throws(() => topologicalSort(['A', 'B'], [['A', 'B'], ['Z', 'A']]), /不存在/);
});

test('运行时状态：未知条件 => blocked(待确认)，绝不默认放行', () => {
  const steps = [
    { step_key: 'S01', dependencies: [] },
    { step_key: 'S02', dependencies: ['S01'] },
  ];
  const app = new Map([
    ['S01', { applicable: true, status: 'yes', reason: null }],
    ['S02', { applicable: false, status: 'unknown', reason: 'model 未确认' }],
  ]);
  const st = deriveStepStates(steps, new Set(), app);
  assert.equal(st.get('S01').state, 'ready');
  assert.equal(st.get('S02').state, 'blocked');
  assert.equal(st.get('S02').unknown, true);
});

test('运行时状态：不适用前驱被视为自动满足；已完成集合生效', () => {
  const steps = [
    { step_key: 'A', dependencies: [] },
    { step_key: 'X', dependencies: ['A'] },   // CB-200 专属，当前 CB-100
    { step_key: 'B', dependencies: ['A', 'X'] },
  ];
  const app = new Map([
    ['A', { applicable: true, status: 'yes' }],
    ['X', { applicable: false, status: 'no' }],
    ['B', { applicable: true, status: 'yes' }],
  ]);
  const st = deriveStepStates(steps, new Set(['A']), app);
  assert.equal(st.get('B').state, 'ready'); // X 不适用，不阻塞 B
  assert.equal(st.get('X').state, 'skipped');
});

test('条件：白名单求值，禁止注入（仅返回假/抛语法错，不执行代码）', () => {
  assert.equal(evaluateCondition("model == 'CB-200'", { model: 'CB-200' }), true);
  assert.equal(evaluateCondition(null, {}), true);
  assert.throws(() => evaluateCondition("model == 'x'; process.exit(1)", {}), /非法|语法|多余/);
  assert.throws(() => evaluateCondition("constructor == 'x'", {}));
});

test('条件：未知上下文 => UnknownCondition（未知即停），null 也不默认', () => {
  assert.equal(evaluateApplicability("model == 'CB-200'", {}).status, 'unknown');
  assert.equal(evaluateApplicability("model == 'CB-200'", { model: null }).status, 'unknown');
  assert.equal(evaluateApplicability("model == 'CB-200'", { model: 'CB-100' }).applicable, false);
});
