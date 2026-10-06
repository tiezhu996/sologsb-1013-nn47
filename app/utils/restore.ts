import type {
  Cue,
  RestoreField,
  RestoreSelection,
  Scene,
  ShowData,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';

export const RESTORE_FIELDS: RestoreField[] = [
  'owner',
  'duration',
  'lighting',
  'sound',
  'props',
  'cast',
  'dependsOn',
];

export const FIELD_LABELS: Record<RestoreField, string> = {
  owner: '负责人',
  duration: '时长',
  lighting: '灯光',
  sound: '音响',
  props: '道具',
  cast: '演员',
  dependsOn: '前置关系',
};

export interface RestoreBlocker {
  kind: 'missing-reference' | 'cross-scene-reference';
  /** 触发问题的待应用项（场次 ID + 提示 ID） */
  sceneId: string;
  cueId: string;
  cueTitle: string;
  /** 找不到或跨场的前置提示 ID */
  reference: string;
  /** cross-scene-reference 时，前置实际所在场次；missing-reference 时为空 */
  referenceSceneName?: string;
  shortTitle: string;
  message: string;
}

export interface RestoreFieldChange {
  field: RestoreField;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface RestoreCueMatch {
  sceneId: string;
  cueId: string;
  /** 当前演出表中的提示；可能缺失（锁定版有、当前已删除） */
  current?: Cue;
  /** 锁定版提示；可能缺失（当前新建的提示，锁定版中没有） */
  locked?: Cue;
  /** 身份（场次 + 提示编号）匹配，但标题已被改名 */
  renamed: boolean;
  /** 身份匹配，且在所属场次内的顺序被挪动 */
  moved: boolean;
  /** 在该场中的当前序号 / 锁定序号（从 1 开始），用于展示，不能用于身份判断 */
  currentIndex?: number;
  lockedIndex?: number;
  changes: RestoreFieldChange[];
  selectedFields: RestoreField[];
}

export interface RestoreSceneGroup {
  sceneId: string;
  sceneLabel: string;
  /** 锁定版中该场次是否已不存在（被删除或换编号） */
  missingScene: boolean;
  matches: RestoreCueMatch[];
}

export interface RestorePlan {
  groups: RestoreSceneGroup[];
  blockers: RestoreBlocker[];
  /** 待应用的字段变更总条数 */
  pendingCount: number;
  /** 存在任意差异字段的提示数 */
  changeCount: number;
}

export interface ApplyRestoreResult {
  ok: boolean;
  /** 写入失败时的错误信息；此时数据已回滚到应用前 */
  error?: string;
  appliedCueCount: number;
  appliedChangeCount: number;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function cueSceneIndex(show: ShowData): Map<string, Scene> {
  const map = new Map<string, Scene>();
  show.scenes.forEach((scene) =>
    scene.cues.forEach((cue) => map.set(cue.id, scene)),
  );
  return map;
}

/** 锁定版里每个场次 ID 的完整标题 */
function lockedSceneLabelsMap(version: VersionSnapshot): Map<string, string> {
  const labels = new Map<string, string>();
  version.data.scenes.forEach((scene) =>
    labels.set(scene.id, `${scene.act} ${scene.name} · ${scene.title}`),
  );
  return labels;
}

function sceneLabel(scene?: Scene): string {
  return scene ? `${scene.act} ${scene.name} · ${scene.title}` : '未知场次';
}

function formatList(value: string[]): string {
  return value.length ? value.join('、') : '—';
}

function formatField(field: RestoreField, cue: Cue): string {
  if (field === 'owner') return cue.owner || '待指定';
  if (field === 'duration') return `${cue.duration} 秒`;
  if (field === 'lighting') return cue.lighting || '—';
  if (field === 'sound') return cue.sound || '—';
  if (field === 'props') return formatList(cue.props);
  if (field === 'cast') return formatList(cue.cast);
  return formatList(cue.dependsOn);
}

function sameFieldValue(
  field: RestoreField,
  current: Cue,
  locked: Cue,
): boolean {
  if (field === 'props' || field === 'cast' || field === 'dependsOn') {
    const left = current[field] as string[];
    const right = locked[field] as string[];
    return (
      left.length === right.length &&
      left.every((value) => right.includes(value))
    );
  }
  return current[field] === locked[field];
}

function describeBlocker(
  blocker: Omit<RestoreBlocker, 'shortTitle' | 'message'>,
): RestoreBlocker {
  if (blocker.kind === 'missing-reference') {
    return {
      ...blocker,
      shortTitle: '找不到前置提示',
      message: `「${blocker.cueTitle}」的前置提示 ${blocker.reference} 在当前演出表中找不到，整批拦住。`,
    };
  }
  return {
    ...blocker,
    shortTitle: '前置跨到场次',
    message: `「${blocker.cueTitle}」的前置提示 ${blocker.reference} 属于${blocker.referenceSceneName ?? '另一场次'}，跨场前置不允许，整批拦住。`,
  };
}

/**
 * 按「所属场次 + 提示编号」对照锁定版与当前演出表。
 * 标题与顺序只用于改名 / 挪场提示，绝不参与身份匹配。
 */
export function buildRestorePlan(
  current: ShowData,
  version: VersionSnapshot,
  selections: RestoreSelection[],
): RestorePlan {
  const selectedMap = new Map<string, Set<RestoreField>>();
  selections.forEach((selection) => {
    selectedMap.set(
      `${selection.sceneId}/${selection.cueId}`,
      new Set(selection.fields),
    );
  });

  const lockedSceneLabels = lockedSceneLabelsMap(version);
  const groups: RestoreSceneGroup[] = [];
  let pendingCount = 0;
  let changeCount = 0;

  // 以当前演出表的场次为骨架，保证当前场次顺序即编辑来源顺序
  current.scenes.forEach((currentScene) => {
    const lockedScene = version.data.scenes.find(
      (scene) => scene.id === currentScene.id,
    );
    const lockedById = new Map<string, { cue: Cue; index: number }>();
    lockedScene?.cues.forEach((cue, index) =>
      lockedById.set(cue.id, { cue, index: index + 1 }),
    );

    const matches: RestoreCueMatch[] = [];
    currentScene.cues.forEach((currentCue, currentIndex) => {
      const lockedEntry = lockedById.get(currentCue.id);
      const lockedCue = lockedEntry?.cue;
      const selectedFields = [
        ...(selectedMap.get(`${currentScene.id}/${currentCue.id}`) ?? []),
      ];

      let changes: RestoreFieldChange[] = [];
      if (lockedCue) {
        changes = RESTORE_FIELDS.map((field) => {
          const before = formatField(field, currentCue);
          const after = formatField(field, lockedCue);
          return {
            field,
            label: FIELD_LABELS[field],
            before,
            after,
            changed: !sameFieldValue(field, currentCue, lockedCue),
          };
        });
        if (changes.some((change) => change.changed)) changeCount += 1;
      }

      if (selectedFields.length) {
        pendingCount += selectedFields.filter((field) =>
          changes.some((change) => change.field === field && change.changed),
        ).length;
      }

      matches.push({
        sceneId: currentScene.id,
        cueId: currentCue.id,
        current: currentCue,
        locked: lockedCue,
        renamed: Boolean(lockedCue && lockedCue.title !== currentCue.title),
        moved: Boolean(lockedEntry && lockedEntry.index !== currentIndex + 1),
        currentIndex: currentIndex + 1,
        lockedIndex: lockedEntry?.index,
        changes,
        selectedFields,
      });
    });

    groups.push({
      sceneId: currentScene.id,
      sceneLabel: sceneLabel(currentScene),
      missingScene: !lockedScene,
      matches,
    });
  });

  // 锁定版中已从当前表消失的场次 / 提示：只展示为不可恢复来源，不能新增回当前表
  version.data.scenes.forEach((lockedScene) => {
    if (current.scenes.some((scene) => scene.id === lockedScene.id)) return;
    groups.push({
      sceneId: lockedScene.id,
      sceneLabel:
        lockedSceneLabels.get(lockedScene.id) ?? sceneLabel(lockedScene),
      missingScene: true,
      matches: lockedScene.cues.map((lockedCue) => ({
        sceneId: lockedScene.id,
        cueId: lockedCue.id,
        locked: lockedCue,
        renamed: false,
        moved: false,
        lockedIndex: lockedScene.cues.indexOf(lockedCue) + 1,
        changes: [],
        selectedFields: [],
      })),
    });
  });

  const blockers = validateSelections(current, version, selections);
  return { groups, blockers, pendingCount, changeCount };
}

/**
 * 整批校验选中的前置关系：
 * - 恢复后的前置引用必须在当前演出表中能按提示编号找到；
 * - 前置提示必须与该提示同属一个场次。
 * 任意一条不满足即整批拦住。
 */
export function validateSelections(
  current: ShowData,
  version: VersionSnapshot,
  selections: RestoreSelection[],
): RestoreBlocker[] {
  const currentCueScenes = cueSceneIndex(current);
  const blockers: RestoreBlocker[] = [];
  const seen = new Set<string>();

  selections.forEach((selection) => {
    if (!selection.fields.includes('dependsOn')) return;
    const lockedScene = version.data.scenes.find(
      (scene) => scene.id === selection.sceneId,
    );
    const lockedCue = lockedScene?.cues.find(
      (cue) => cue.id === selection.cueId,
    );
    if (!lockedScene || !lockedCue) return;

    lockedCue.dependsOn.forEach((reference) => {
      const currentSceneOfRef = currentCueScenes.get(reference);
      const dedupeKey = `${selection.sceneId}/${selection.cueId}/${reference}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      if (!currentSceneOfRef) {
        blockers.push(
          describeBlocker({
            kind: 'missing-reference',
            sceneId: selection.sceneId,
            cueId: selection.cueId,
            cueTitle: lockedCue.title,
            reference,
          }),
        );
        return;
      }
      // 同场校验以当前演出表的归属为准（挪场后以当前编排为来源）
      if (currentSceneOfRef.id !== selection.sceneId) {
        blockers.push(
          describeBlocker({
            kind: 'cross-scene-reference',
            sceneId: selection.sceneId,
            cueId: selection.cueId,
            cueTitle: lockedCue.title,
            reference,
            referenceSceneName: sceneLabel(currentSceneOfRef),
          }),
        );
      }
    });
  });

  return blockers;
}

/**
 * 将选中的锁定版字段应用到当前演出表的深拷贝上。
 * 返回新数据；调用方负责持久化与失败回滚。重试时由同一份操作前数据重新计算，天然幂等。
 */
export function applySelections(
  current: ShowData,
  version: VersionSnapshot,
  selections: RestoreSelection[],
): ShowData {
  // 先克隆再计算：绝不原地修改操作前数据，回滚与重试都依赖这一点
  const next = clone(current);
  const lockedData = version.data;
  selections.forEach((selection) => {
    if (!selection.fields.length) return;
    const scene = next.scenes.find((item) => item.id === selection.sceneId);
    const lockedScene = lockedData.scenes.find(
      (item) => item.id === selection.sceneId,
    );
    const cue = scene?.cues.find((item) => item.id === selection.cueId);
    const lockedCue = lockedScene?.cues.find(
      (item) => item.id === selection.cueId,
    );
    if (!scene || !cue || !lockedCue) return;

    selection.fields.forEach((field) => {
      if (field === 'duration') {
        cue.duration = lockedCue.duration;
      } else if (
        field === 'props' ||
        field === 'cast' ||
        field === 'dependsOn'
      ) {
        cue[field] = clone(lockedCue[field]);
      } else if (field === 'owner') {
        cue.owner = lockedCue.owner;
      } else if (field === 'lighting') {
        cue.lighting = lockedCue.lighting;
      } else if (field === 'sound') {
        cue.sound = lockedCue.sound;
      }
    });
  });

  // 应用后逐场重算提示偏移（offset 在每场内部从 0 起算），保持时间轴一致
  next.scenes.forEach((scene) => {
    let elapsed = 0;
    scene.cues.forEach((cue) => {
      cue.offset = elapsed;
      elapsed += Number(cue.duration) || 0;
    });
  });
  next.updatedAt = new Date().toISOString();
  return next;
}

/** 早期数据没有版本来源标记时，按当前记录兼容显示 */
export function versionSourceLabel(version: VersionSnapshot): string {
  return version.source?.trim() || '未标注来源（按当前记录兼容显示）';
}
