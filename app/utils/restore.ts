import type {
  Cue,
  Scene,
  ShowData,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** 恢复时可选的内容分组。 */
export interface RestoreFieldGroups {
  owner: boolean;
  duration: boolean;
  tech: boolean;
  people: boolean;
  depends: boolean;
}

export const DEFAULT_RESTORE_FIELDS: RestoreFieldGroups = {
  owner: true,
  duration: true,
  tech: true,
  people: true,
  depends: true,
};

/** 待应用区里的一条选择：身份＝提示编号＋所属场次。 */
export interface RestoreSelection {
  sceneId: string;
  cueId: string;
}

export function selectionKey(selection: RestoreSelection): string {
  return `${selection.sceneId}::${selection.cueId}`;
}

export type RestoreMatch =
  | { type: 'update'; scene: Scene; cue: Cue }
  | { type: 'moved'; scene: Scene; cue: Cue }
  | { type: 'reinsert'; scene: Scene }
  | { type: 'missing-scene' };

/**
 * 按提示编号和所属场次对照身份；顺序与标题不参与匹配。
 * 改名、调序的提示仍命中原身份；挪场（编号出现在别的场次）按 moved
 * 就地更新，不当成新增，避免重复编号导致旧引用断裂。
 */
export function matchCue(
  show: ShowData,
  sceneId: string,
  cueId: string,
): RestoreMatch {
  const scene = show.scenes.find((item) => item.id === sceneId);
  const own = scene?.cues.find((item) => item.id === cueId);
  if (scene && own) return { type: 'update', scene, cue: own };
  for (const other of show.scenes) {
    const cue = other.cues.find((item) => item.id === cueId);
    if (cue) return { type: 'moved', scene: other, cue };
  }
  if (scene) return { type: 'reinsert', scene };
  return { type: 'missing-scene' };
}

export interface RestoreProblem {
  key: string;
  kind:
    | 'missing-cue'
    | 'missing-scene'
    | 'scene-locked'
    | 'missing-ref'
    | 'cross-scene-ref';
  message: string;
}

export interface RestorePlan {
  /** 校验通过时为可提交的新数据；被拦住时为传入的原数据（整批未动）。 */
  next: ShowData;
  problems: RestoreProblem[];
  applied: number;
}

export function recalculateScene(scene: Scene): void {
  let elapsed = 0;
  scene.cues.forEach((item) => {
    item.offset = elapsed;
    elapsed += Number(item.duration) || 0;
  });
}

export function sceneLabel(scene: Scene): string {
  return `${scene.act} ${scene.name} · ${scene.title}`;
}

/**
 * 生成恢复计划。锁定版保持只读，当前演出表也不会被改动；
 * 任一前置引用找不到对应提示或跨到别的场次，整批拦住
 * （problems 非空，next 原样返回，applied 为 0）。
 */
export function buildRestorePlan(
  show: ShowData,
  version: VersionSnapshot,
  selections: RestoreSelection[],
  fields: RestoreFieldGroups,
): RestorePlan {
  const problems: RestoreProblem[] = [];
  const next = clone(show);
  const dependsChecks: Array<{
    title: string;
    homeSceneId: string;
    refs: string[];
  }> = [];
  const seen = new Set<string>();
  let applied = 0;

  for (const selection of selections) {
    const key = selectionKey(selection);
    if (seen.has(key)) continue; // 重试或重复勾选不会重复追加
    seen.add(key);
    const lockedScene = version.data.scenes.find(
      (item) => item.id === selection.sceneId,
    );
    const lockedCue = lockedScene?.cues.find(
      (item) => item.id === selection.cueId,
    );
    if (!lockedScene || !lockedCue) {
      problems.push({
        key,
        kind: 'missing-cue',
        message: `锁定版中找不到提示 ${selection.cueId}。`,
      });
      continue;
    }
    const match = matchCue(next, selection.sceneId, selection.cueId);
    if (match.type === 'missing-scene') {
      problems.push({
        key,
        kind: 'missing-scene',
        message: `当前演出表缺少场次「${sceneLabel(lockedScene)}」，无法安置「${lockedCue.title}」。`,
      });
      continue;
    }
    if (match.scene.locked) {
      problems.push({
        key,
        kind: 'scene-locked',
        message: `「${sceneLabel(match.scene)}」已锁定，请先建立修订。`,
      });
      continue;
    }
    if (match.type === 'reinsert') {
      // 已删除的提示按原编号补回，旧引用随之恢复；未勾选的内容留空
      const restored: Cue = {
        ...clone(lockedCue),
        owner: fields.owner ? lockedCue.owner : '',
        duration: fields.duration ? lockedCue.duration : 60,
        lighting: fields.tech ? lockedCue.lighting : '',
        sound: fields.tech ? lockedCue.sound : '',
        props: fields.people ? clone(lockedCue.props) : [],
        cast: fields.people ? clone(lockedCue.cast) : [],
        dependsOn: fields.depends ? clone(lockedCue.dependsOn) : [],
        offset: 0,
        sourceVersion: version.name,
      };
      match.scene.cues.push(restored);
      if (fields.depends) {
        dependsChecks.push({
          title: restored.title,
          homeSceneId: match.scene.id,
          refs: restored.dependsOn,
        });
      }
      applied += 1;
      continue;
    }
    // update / moved：就地更新勾选的内容，保留当前标题、顺序和未勾选内容
    const target = match.cue;
    if (fields.owner) target.owner = lockedCue.owner;
    if (fields.duration) target.duration = lockedCue.duration;
    if (fields.tech) {
      target.lighting = lockedCue.lighting;
      target.sound = lockedCue.sound;
    }
    if (fields.people) {
      target.props = clone(lockedCue.props);
      target.cast = clone(lockedCue.cast);
    }
    if (fields.depends) {
      target.dependsOn = clone(lockedCue.dependsOn);
      dependsChecks.push({
        title: target.title,
        homeSceneId: match.scene.id,
        refs: target.dependsOn,
      });
    }
    target.sourceVersion = version.name;
    applied += 1;
  }

  // 前置关系整批校验：还原后的每条引用都必须落在提示所属的同一场次
  for (const check of dependsChecks) {
    for (const ref of check.refs) {
      const found = next.scenes
        .flatMap((scene) => scene.cues.map((cue) => ({ scene, cue })))
        .find((entry) => entry.cue.id === ref);
      if (!found) {
        problems.push({
          key: `${check.homeSceneId}::${ref}`,
          kind: 'missing-ref',
          message: `「${check.title}」的前置 ${ref} 找不到对应提示。`,
        });
      } else if (found.scene.id !== check.homeSceneId) {
        problems.push({
          key: `${check.homeSceneId}::${ref}`,
          kind: 'cross-scene-ref',
          message: `「${check.title}」的前置「${found.cue.title}」在 ${found.scene.act} ${found.scene.name}，前置不能跨场次。`,
        });
      }
    }
  }

  if (problems.length) return { next: show, problems, applied: 0 };
  next.scenes.forEach((scene) => recalculateScene(scene));
  return { next, problems, applied };
}

/**
 * 兼容旧数据：补齐缺失字段并重算场次时间。
 * 没有版本来源（sourceVersion）的提示保持缺省，界面按“当前记录”显示。
 */
export function normalizeShow(
  raw: ShowData | null | undefined,
): ShowData | null {
  if (!raw || !Array.isArray(raw.scenes)) return null;
  raw.scenes.forEach((scene) => {
    scene.act = scene.act ?? '';
    scene.name = scene.name ?? '';
    scene.title = scene.title ?? '';
    scene.startTime = scene.startTime ?? '19:30';
    scene.locked = Boolean(scene.locked);
    scene.cues = Array.isArray(scene.cues) ? scene.cues : [];
    scene.cues.forEach((item) => {
      item.kind = item.kind ?? '舞台';
      item.title = item.title ?? '';
      item.duration = Number(item.duration) || 60;
      item.owner = item.owner ?? '';
      item.lighting = item.lighting ?? '';
      item.sound = item.sound ?? '';
      item.props = Array.isArray(item.props) ? item.props : [];
      item.cast = Array.isArray(item.cast) ? item.cast : [];
      item.notes = item.notes ?? '';
      item.dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn : [];
      item.offset = Number(item.offset) || 0;
    });
    recalculateScene(scene);
  });
  return raw;
}

export function normalizeVersions(
  raw: VersionSnapshot[] | null | undefined,
): VersionSnapshot[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((version) => version && normalizeShow(version.data))
    .map((version, index) => ({
      ...version,
      id: version.id ?? `version-legacy-${index}`,
      name: version.name ?? `旧锁定版 ${index + 1}`,
      createdAt: version.createdAt ?? '',
    }));
}
