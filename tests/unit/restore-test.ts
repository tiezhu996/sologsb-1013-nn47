import { module, test } from 'qunit';
import type {
  Cue,
  Scene,
  ShowData,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import type { RestoreFieldGroups } from 'stage-cue-editor/utils/restore';
import {
  buildRestorePlan,
  matchCue,
  normalizeShow,
  normalizeVersions,
  recalculateScene,
} from 'stage-cue-editor/utils/restore';

const ALL_FIELDS: RestoreFieldGroups = {
  owner: true,
  duration: true,
  tech: true,
  people: true,
  depends: true,
};

function makeCue(id: string, extra: Partial<Cue> = {}): Cue {
  return {
    id,
    kind: '灯光',
    title: `提示 ${id}`,
    duration: 60,
    owner: '李岚',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    ...extra,
  };
}

function makeScene(id: string, cues: Cue[], extra: Partial<Scene> = {}): Scene {
  const scene: Scene = {
    id,
    act: '第一幕',
    name: id.toUpperCase(),
    title: `场次 ${id}`,
    startTime: '19:30',
    locked: false,
    cues,
    ...extra,
  };
  recalculateScene(scene);
  return scene;
}

function makeShow(scenes: Scene[]): ShowData {
  return {
    title: '测试演出',
    venue: '测试厅',
    date: '2026-10-06',
    scenes,
    updatedAt: '2026-10-06T00:00:00.000Z',
  };
}

function makeVersion(data: ShowData, name = '锁定版 1'): VersionSnapshot {
  return { id: 'v1', name, createdAt: '2026-10-01T00:00:00.000Z', data };
}

module('Unit | Utility | restore', function () {
  test('matchCue 按提示编号和所属场次对照身份', function (assert) {
    const show = makeShow([
      makeScene('s1', [makeCue('a')]),
      makeScene('s2', [makeCue('b')]),
    ]);

    const update = matchCue(show, 's1', 'a');
    assert.strictEqual(update.type, 'update', '同场同号命中 update');

    const moved = matchCue(show, 's1', 'b');
    assert.strictEqual(moved.type, 'moved', '编号在别的场次命中 moved');
    assert.strictEqual(
      moved.type === 'moved' ? moved.scene.id : '',
      's2',
      'moved 返回当前所在场次',
    );

    assert.strictEqual(
      matchCue(show, 's1', 'x').type,
      'reinsert',
      '场次在、编号不在命中 reinsert',
    );
    assert.strictEqual(
      matchCue(show, 's9', 'x').type,
      'missing-scene',
      '场次与编号都不在命中 missing-scene',
    );
  });

  test('改名后的提示按编号就地更新，不被当成新增', function (assert) {
    const show = makeShow([
      makeScene('s1', [
        makeCue('a', { title: '新名字', owner: '李岚', duration: 10 }),
      ]),
    ]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [
          makeCue('a', { title: '旧名字', owner: '周启', duration: 45 }),
        ]),
      ]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.problems.length, 0);
    assert.strictEqual(plan.applied, 1);
    const cue = plan.next.scenes[0]!.cues;
    assert.strictEqual(cue.length, 1, '没有新增提示');
    assert.strictEqual(cue[0]!.title, '新名字', '当前标题保留，身份不靠标题');
    assert.strictEqual(cue[0]!.owner, '周启', '负责人已恢复');
    assert.strictEqual(cue[0]!.duration, 45, '时长已恢复');
    assert.strictEqual(cue[0]!.sourceVersion, '锁定版 1', '记录恢复来源');
    assert.strictEqual(
      show.scenes[0]!.cues[0]!.owner,
      '李岚',
      '原数据未被改动',
    );
  });

  test('挪场后的提示就地更新，不重复追加', function (assert) {
    const show = makeShow([
      makeScene('s1', []),
      makeScene('s2', [makeCue('a', { owner: '李岚' })]),
    ]);
    const version = makeVersion(
      makeShow([makeScene('s1', [makeCue('a', { owner: '周启' })])]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.problems.length, 0);
    assert.strictEqual(plan.next.scenes[0]!.cues.length, 0, '原场次不新增');
    assert.strictEqual(
      plan.next.scenes[1]!.cues.length,
      1,
      '当前所在场次不重复',
    );
    assert.strictEqual(
      plan.next.scenes[1]!.cues[0]!.owner,
      '周启',
      '在挪到的场次就地更新',
    );
  });

  test('已删除的提示按原编号补回，旧引用随之恢复', function (assert) {
    const show = makeShow([
      makeScene('s1', [makeCue('s', { dependsOn: ['gone'] })]),
    ]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [makeCue('gone', { duration: 30, owner: '陈默' })]),
      ]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'gone' }],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.problems.length, 0);
    const ids = plan.next.scenes[0]!.cues.map((cue) => cue.id);
    assert.deepEqual(ids, ['s', 'gone'], '按原编号补回');
    const restored = plan.next.scenes[0]!.cues[1]!;
    assert.strictEqual(restored.duration, 30);
    assert.strictEqual(restored.sourceVersion, '锁定版 1');
    assert.ok(
      plan.next.scenes[0]!.cues.some((cue) => cue.id === 'gone'),
      '指向 gone 的旧引用重新找到对应提示',
    );
  });

  test('前置引用找不到对应提示时整批拦住', function (assert) {
    const show = makeShow([makeScene('s1', [makeCue('a', { owner: '李岚' })])]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [
          makeCue('a', { owner: '周启', dependsOn: ['ghost'] }),
          makeCue('b', { owner: '孙禾' }),
        ]),
      ]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [
        { sceneId: 's1', cueId: 'a' },
        { sceneId: 's1', cueId: 'b' },
      ],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.applied, 0, '整批未应用');
    assert.strictEqual(plan.problems.length, 1);
    assert.strictEqual(plan.problems[0]!.kind, 'missing-ref');
    assert.strictEqual(plan.next, show, '返回操作前数据');
    assert.strictEqual(
      plan.next.scenes[0]!.cues.length,
      1,
      '同批其他提示也没有被追加',
    );
  });

  test('前置引用跨到别的场次时整批拦住', function (assert) {
    const show = makeShow([
      makeScene('s1', [makeCue('a')]),
      makeScene('s2', [makeCue('z')]),
    ]);
    const version = makeVersion(
      makeShow([makeScene('s1', [makeCue('a', { dependsOn: ['z'] })])]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.applied, 0);
    assert.strictEqual(plan.problems.length, 1);
    assert.strictEqual(plan.problems[0]!.kind, 'cross-scene-ref');
  });

  test('未勾选前置关系时不校验也不写回引用', function (assert) {
    const show = makeShow([
      makeScene('s1', [makeCue('a')]),
      makeScene('s2', [makeCue('z')]),
    ]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [makeCue('a', { owner: '周启', dependsOn: ['z'] })]),
      ]),
    );
    const fields: RestoreFieldGroups = { ...ALL_FIELDS, depends: false };

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      fields,
    );

    assert.strictEqual(plan.problems.length, 0);
    assert.deepEqual(
      plan.next.scenes[0]!.cues[0]!.dependsOn,
      [],
      '前置关系保持当前值',
    );
    assert.strictEqual(
      plan.next.scenes[0]!.cues[0]!.owner,
      '周启',
      '勾选的内容仍然恢复',
    );
  });

  test('同批补回被依赖的提示后前置校验通过', function (assert) {
    const show = makeShow([makeScene('s1', [makeCue('s')])]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [
          makeCue('s', { dependsOn: ['gone'] }),
          makeCue('gone', { duration: 30 }),
        ]),
      ]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [
        { sceneId: 's1', cueId: 's' },
        { sceneId: 's1', cueId: 'gone' },
      ],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.problems.length, 0, '同批补回后引用找得到');
    assert.deepEqual(plan.next.scenes[0]!.cues[0]!.dependsOn, ['gone']);
    assert.ok(plan.next.scenes[0]!.cues.some((cue) => cue.id === 'gone'));
  });

  test('重试不会重复追加（计划幂等）', function (assert) {
    const show = makeShow([
      makeScene('s1', [makeCue('s', { dependsOn: ['gone'] })]),
    ]);
    const version = makeVersion(
      makeShow([makeScene('s1', [makeCue('gone', { duration: 30 })])]),
    );
    const selections = [{ sceneId: 's1', cueId: 'gone' }];

    const first = buildRestorePlan(show, version, selections, ALL_FIELDS);
    assert.strictEqual(first.problems.length, 0);
    const retry = buildRestorePlan(first.next, version, selections, ALL_FIELDS);

    assert.strictEqual(retry.problems.length, 0);
    assert.deepEqual(
      retry.next.scenes[0]!.cues.map((cue) => cue.id),
      ['s', 'gone'],
      '再次应用同一批选择不产生重复提示',
    );
  });

  test('只恢复勾选的内容分组', function (assert) {
    const show = makeShow([
      makeScene('s1', [
        makeCue('a', {
          owner: '李岚',
          duration: 10,
          lighting: '现灯',
          props: ['现具'],
        }),
      ]),
    ]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [
          makeCue('a', {
            owner: '周启',
            duration: 99,
            lighting: '旧灯',
            sound: '旧音',
            props: ['旧具'],
            cast: ['旧角'],
          }),
        ]),
      ]),
    );
    const fields: RestoreFieldGroups = {
      owner: false,
      duration: true,
      tech: false,
      people: false,
      depends: false,
    };

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      fields,
    );
    const cue = plan.next.scenes[0]!.cues[0]!;

    assert.strictEqual(cue.owner, '李岚', '未勾选的负责人保持当前值');
    assert.strictEqual(cue.duration, 99, '勾选的时长被恢复');
    assert.strictEqual(cue.lighting, '现灯', '未勾选的灯光保持当前值');
    assert.deepEqual(cue.props, ['现具'], '未勾选的道具保持当前值');
  });

  test('应用后重算场次时间', function (assert) {
    const show = makeShow([
      makeScene('s1', [
        makeCue('a', { duration: 10 }),
        makeCue('b', { duration: 20 }),
      ]),
    ]);
    const version = makeVersion(
      makeShow([makeScene('s1', [makeCue('a', { duration: 50 })])]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      ALL_FIELDS,
    );
    const cues = plan.next.scenes[0]!.cues;

    assert.strictEqual(cues[0]!.offset, 0);
    assert.strictEqual(cues[1]!.offset, 50, '后续提示按新时长顺延');
  });

  test('锁定版保持只读，当前演出表也不被计划改动', function (assert) {
    const show = makeShow([makeScene('s1', [makeCue('a')])]);
    const version = makeVersion(
      makeShow([
        makeScene('s1', [makeCue('a', { owner: '周启' }), makeCue('new')]),
      ]),
    );
    const showBefore = JSON.parse(JSON.stringify(show));
    const versionBefore = JSON.parse(JSON.stringify(version));

    buildRestorePlan(
      show,
      version,
      [
        { sceneId: 's1', cueId: 'a' },
        { sceneId: 's1', cueId: 'new' },
      ],
      ALL_FIELDS,
    );

    assert.deepEqual(
      JSON.parse(JSON.stringify(show)),
      showBefore,
      '当前演出表未被改动',
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(version)),
      versionBefore,
      '锁定版保持只读',
    );
  });

  test('目标场次已锁定时整批拦住', function (assert) {
    const show = makeShow([makeScene('s1', [makeCue('a')], { locked: true })]);
    const version = makeVersion(
      makeShow([makeScene('s1', [makeCue('a', { owner: '周启' })])]),
    );

    const plan = buildRestorePlan(
      show,
      version,
      [{ sceneId: 's1', cueId: 'a' }],
      ALL_FIELDS,
    );

    assert.strictEqual(plan.applied, 0);
    assert.strictEqual(plan.problems[0]!.kind, 'scene-locked');
  });

  test('normalizeShow 兼容没有版本来源的旧数据', function (assert) {
    const legacy = {
      title: '旧存档',
      scenes: [
        { id: 's1', cues: [{ id: 'a', title: '旧提示', duration: 30 }] },
      ],
    } as unknown as ShowData;

    const normalized = normalizeShow(legacy);
    const cue = normalized!.scenes[0]!.cues[0]!;

    assert.deepEqual(cue.props, [], '补齐道具数组');
    assert.deepEqual(cue.cast, [], '补齐演员数组');
    assert.deepEqual(cue.dependsOn, [], '补齐前置数组');
    assert.strictEqual(cue.lighting, '', '补齐灯光字段');
    assert.strictEqual(
      cue.sourceVersion,
      undefined,
      '没有版本来源时保持缺省，界面按当前记录显示',
    );
    assert.strictEqual(normalizeShow(null), null, '无效数据返回 null');
  });

  test('normalizeVersions 兼容旧锁定版', function (assert) {
    assert.deepEqual(normalizeVersions(undefined), [], '缺失时返回空数组');
    const legacy = [
      {
        data: { scenes: [{ id: 's1', cues: [] }] },
      } as unknown as VersionSnapshot,
    ];
    const versions = normalizeVersions(legacy);
    assert.strictEqual(versions.length, 1);
    assert.ok(versions[0]!.id, '补齐版本 id');
    assert.ok(versions[0]!.name, '补齐版本名称');
  });
});
