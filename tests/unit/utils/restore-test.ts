import { module, test } from 'qunit';
import type {
  Cue,
  RestoreSelection,
  Scene,
  ShowData,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import {
  applySelections,
  buildRestorePlan,
  validateSelections,
  versionSourceLabel,
} from 'stage-cue-editor/utils/restore';

function makeCue(id: string, overrides: Partial<Cue> = {}): Cue {
  return {
    id,
    kind: '灯光',
    title: id,
    duration: 60,
    owner: '李岚',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    ...overrides,
  };
}

function makeScene(
  id: string,
  cues: Cue[],
  overrides: Partial<Scene> = {},
): Scene {
  let elapsed = 0;
  cues.forEach((cue) => {
    cue.offset = elapsed;
    elapsed += cue.duration;
  });
  return {
    id,
    act: '第一幕',
    name: id,
    title: id,
    startTime: '19:30',
    locked: false,
    cues,
    ...overrides,
  };
}

function makeShow(scenes: Scene[]): ShowData {
  return {
    title: '当前演出表',
    venue: 'A 厅',
    date: '2026-10-18',
    scenes,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

function makeVersion(
  show: ShowData,
  overrides: Partial<VersionSnapshot> = {},
): VersionSnapshot {
  return {
    id: 'version-1',
    name: '锁定版 1',
    createdAt: '2026-09-01T00:00:00.000Z',
    data: show,
    ...overrides,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

module('Unit | Utility | restore', function () {
  test('按场次 + 提示编号配对，改名和挪序不影响身份', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [
          makeCue('cue-a', { title: '旧标题 A', duration: 100, owner: '陈默' }),
          makeCue('cue-b', { title: '提示 B' }),
        ]),
      ]),
    );
    // 当前表：cue-a 改名，cue-b 与 cue-a 调换顺序（身份不变）
    const current = makeShow([
      makeScene('scene-1', [
        makeCue('cue-b', { title: '提示 B' }),
        makeCue('cue-a', { title: '新标题 A', duration: 200, owner: '李岚' }),
      ]),
    ]);

    const plan = buildRestorePlan(current, locked, []);
    const group = plan.groups.find((item) => item.sceneId === 'scene-1')!;
    const cueA = group.matches.find((item) => item.cueId === 'cue-a')!;
    const cueB = group.matches.find((item) => item.cueId === 'cue-b')!;

    assert.ok(cueA.locked, 'cue-a 仅凭编号就找到锁定版');
    assert.ok(cueA.current, 'cue-a 仅凭编号就找到当前表');
    assert.true(cueA.renamed, '标记为已改名');
    assert.true(cueA.moved, '标记为顺序挪动');
    assert.strictEqual(cueA.currentIndex, 2);
    assert.strictEqual(cueA.lockedIndex, 1);
    assert.false(cueB.renamed, '未改名的提示不误报');
    assert.true(cueB.moved, 'cue-b 同样只是挪序');

    const ownerChange = cueA.changes.find(
      (change) => change.field === 'owner',
    )!;
    const durationChange = cueA.changes.find(
      (change) => change.field === 'duration',
    )!;
    assert.true(ownerChange.changed, '负责人差异被识别');
    assert.strictEqual(ownerChange.before, '李岚');
    assert.strictEqual(ownerChange.after, '陈默');
    assert.true(durationChange.changed, '时长差异被识别');
  });

  test('标题相同但编号不同的提示不会被当成同一条', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [makeCue('cue-old', { title: '面光起' })]),
      ]),
    );
    const current = makeShow([
      makeScene('scene-1', [makeCue('cue-new', { title: '面光起' })]),
    ]);

    const plan = buildRestorePlan(current, locked, []);
    const currentGroup = plan.groups.find(
      (group) => group.sceneId === 'scene-1',
    )!;
    const currentMatch = currentGroup.matches.find(
      (item) => item.cueId === 'cue-new',
    )!;
    assert.notOk(currentMatch.locked, '标题相同的新编号不会错配到锁定版');
    assert.strictEqual(
      currentMatch.changes.length,
      0,
      '无锁定来源就没有可恢复字段',
    );

    const goneGroup = plan.groups.find((group) =>
      group.matches.some((match) => match.cueId === 'cue-old'),
    )!;
    const goneMatch = goneGroup.matches.find(
      (item) => item.cueId === 'cue-old',
    )!;
    assert.notOk(
      goneMatch.current,
      '锁定版旧编号只展示为已删除，不会被新增回来',
    );
  });

  test('跨场次挪场的提示只在当前所属场次下对照，不会错配到同编号的他场', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [makeCue('cue-x', { owner: '陈默' })]),
        makeScene('scene-2', []),
      ]),
    );
    // cue-x 当前挪到了 scene-2；scene-1 里用同编号是不可能的（编号全局唯一），
    // 这里验证它出现在当前所属场次 scene-2 下
    const current = makeShow([
      makeScene('scene-1', []),
      makeScene('scene-2', [makeCue('cue-x', { owner: '李岚' })]),
    ]);

    const plan = buildRestorePlan(current, locked, []);
    const inScene2 = plan.groups
      .find((group) => group.sceneId === 'scene-2')!
      .matches.find((item) => item.cueId === 'cue-x');
    assert.ok(inScene2?.locked, '挪场后按当前场次归属仍能按编号找到锁定内容');
  });

  test('前置引用找不到对应提示时整批拦住', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [
          makeCue('cue-a', { dependsOn: ['cue-missing'] }),
        ]),
      ]),
    );
    const current = makeShow([
      makeScene('scene-1', [makeCue('cue-a', { dependsOn: [] })]),
    ]);
    const selections: RestoreSelection[] = [
      { sceneId: 'scene-1', cueId: 'cue-a', fields: ['dependsOn'] },
    ];

    const blockers = validateSelections(current, locked, selections);
    assert.strictEqual(blockers.length, 1);
    assert.strictEqual(blockers[0]!.kind, 'missing-reference');
    assert.strictEqual(blockers[0]!.reference, 'cue-missing');
    assert.true(
      buildRestorePlan(current, locked, selections).blockers.length > 0,
    );
  });

  test('前置引用跨到场次时整批拦住', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [makeCue('cue-a', { dependsOn: ['cue-other'] })]),
        makeScene('scene-2', [makeCue('cue-other')]),
      ]),
    );
    // 当前表中 cue-other 存在，但属于 scene-2；cue-a 在 scene-1
    const current = makeShow([
      makeScene('scene-1', [makeCue('cue-a', { dependsOn: [] })]),
      makeScene('scene-2', [makeCue('cue-other')]),
    ]);
    const selections: RestoreSelection[] = [
      { sceneId: 'scene-1', cueId: 'cue-a', fields: ['dependsOn'] },
    ];

    const blockers = validateSelections(current, locked, selections);
    assert.strictEqual(blockers.length, 1);
    assert.strictEqual(blockers[0]!.kind, 'cross-scene-reference');
    assert.true(blockers[0]!.message.includes('scene-2'));
  });

  test('前置引用在同一场次可找到时不拦截，其余字段不受影响', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [
          makeCue('cue-a', { dependsOn: ['cue-b'], owner: '陈默' }),
          makeCue('cue-b'),
        ]),
      ]),
    );
    const current = makeShow([
      makeScene('scene-1', [
        makeCue('cue-a', { dependsOn: [], owner: '李岚' }),
        makeCue('cue-b'),
      ]),
    ]);
    const selections: RestoreSelection[] = [
      { sceneId: 'scene-1', cueId: 'cue-a', fields: ['dependsOn', 'owner'] },
    ];

    assert.strictEqual(
      validateSelections(current, locked, selections).length,
      0,
    );
  });

  test('应用只写入选中字段并重算场次时长，锁定版保持不变', function (assert) {
    const lockedShow = makeShow([
      makeScene('scene-1', [
        makeCue('cue-a', {
          duration: 100,
          owner: '陈默',
          lighting: '面光 80%',
        }),
        makeCue('cue-b', { duration: 100, owner: '孙禾' }),
      ]),
    ]);
    const locked = makeVersion(clone(lockedShow));
    const current = makeShow([
      makeScene('scene-1', [
        makeCue('cue-a', { duration: 200, owner: '李岚', lighting: '' }),
        makeCue('cue-b', { duration: 100, owner: '孙禾' }),
      ]),
    ]);
    const before = clone(current);
    const selections: RestoreSelection[] = [
      { sceneId: 'scene-1', cueId: 'cue-a', fields: ['duration', 'owner'] },
    ];

    const next = applySelections(current, locked, selections);
    const scene = next.scenes[0]!;
    const cueA = scene.cues.find((cue) => cue.id === 'cue-a')!;
    const cueB = scene.cues.find((cue) => cue.id === 'cue-b')!;

    assert.strictEqual(cueA.duration, 100, '时长已恢复');
    assert.strictEqual(cueA.owner, '陈默', '负责人已恢复');
    assert.strictEqual(cueA.lighting, '', '未勾选的灯光保持当前值');
    assert.strictEqual(cueA.offset, 0);
    assert.strictEqual(cueB.offset, 100, '后续提示 offset 已重算');

    assert.deepEqual(locked.data, lockedShow, '锁定版快照只读未变');
    assert.deepEqual(current, before, '操作前数据未被原地修改');
  });

  test('基于操作前数据重试不会重复追加', function (assert) {
    const locked = makeVersion(
      makeShow([
        makeScene('scene-1', [
          makeCue('cue-a', { props: ['月牙灯', '折扇'], cast: ['说书人'] }),
        ]),
      ]),
    );
    const current = makeShow([makeScene('scene-1', [makeCue('cue-a')])]);
    const selections: RestoreSelection[] = [
      { sceneId: 'scene-1', cueId: 'cue-a', fields: ['props', 'cast'] },
    ];

    const first = applySelections(clone(current), locked, selections);
    // 模拟写入失败后用同一份操作前数据重试
    const retry = applySelections(clone(current), locked, selections);
    const firstCue = first.scenes[0]!.cues[0]!;
    const retryCue = retry.scenes[0]!.cues[0]!;

    assert.deepEqual(retryCue.props, ['月牙灯', '折扇']);
    assert.deepEqual(retryCue.cast, ['说书人']);
    assert.deepEqual(
      retryCue.props,
      firstCue.props,
      '重试结果与首次一致，无重复追加',
    );
    assert.strictEqual(retryCue.props.length, 2);
  });

  test('没有版本来源的旧快照按当前记录兼容显示', function (assert) {
    const oldVersion = makeVersion(makeShow([]));
    delete (oldVersion as Partial<VersionSnapshot>).source;
    assert.strictEqual(
      versionSourceLabel(oldVersion),
      '未标注来源（按当前记录兼容显示）',
    );

    const sourced = makeVersion(makeShow([]), { source: '彩排后锁定' });
    assert.strictEqual(versionSourceLabel(sourced), '彩排后锁定');
  });
});
