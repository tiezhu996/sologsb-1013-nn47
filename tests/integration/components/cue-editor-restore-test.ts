import { module, test } from 'qunit';
import { setupRenderingTest } from 'stage-cue-editor/tests/helpers';
import { click, render, type RenderingTestContext } from '@ember/test-helpers';
import { hbs } from 'ember-cli-htmlbars';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';

function buttonByText(
  root: Element | Document,
  text: string,
): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((el) =>
    el.textContent?.includes(text),
  );
  if (!found) throw new Error(`button not found: ${text}`);
  return found as HTMLButtonElement;
}

function restoreCheckboxes(
  root: Element | Document,
): NodeListOf<HTMLInputElement> {
  return root.querySelectorAll<HTMLInputElement>(
    '.restore-cue input[type="checkbox"]',
  );
}

module('Integration | Component | cue-editor restore desk', function (hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function () {
    localStorage.removeItem(STORAGE_KEY);
  });

  test('恢复台按编号挑回提示，写入失败回滚并保留已选项，重试不重复追加', async function (this: RenderingTestContext, assert) {
    await render(hbs`<CueEditor />`);

    await click(buttonByText(this.element, '打开恢复台'));
    assert.dom('.restore-overlay').exists('恢复台已打开');
    assert
      .dom('.restore-queue-list .queue-row')
      .doesNotExist('待应用区初始为空');

    await click(restoreCheckboxes(this.element)[0]!); // cue-light-1：同号在场，就地更新
    await click(restoreCheckboxes(this.element)[3]!); // cue-deleted-old：当前已删除，按原编号补回
    assert
      .dom('.restore-queue-list .queue-row')
      .exists({ count: 2 }, '选中的内容先列在待应用区');
    assert.dom('.cue-row').exists({ count: 4 }, '应用前演出表不变');

    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    await click(buttonByText(this.element, '应用恢复'));

    assert.dom('.toast-message').includesText('写入失败', '提示写入失败');
    assert.dom('.cue-row').exists({ count: 4 }, '写入失败后恢复操作前数据');
    assert
      .dom('.restore-queue-list .queue-row')
      .exists({ count: 2 }, '已选项保留在待应用区');
    assert.dom(restoreCheckboxes(this.element)[0]!).isChecked('勾选状态保留');

    localStorage.setItem = originalSetItem;
    await click(buttonByText(this.element, '应用恢复'));

    assert.dom('.toast-message').includesText('已恢复 2 条提示');
    assert.dom('.cue-row').exists({ count: 5 }, '重试只补回一条，没有重复追加');
    assert
      .dom('.restore-queue-list .queue-row')
      .doesNotExist('应用成功后待应用区清空');
    assert
      .dom(this.element.querySelector('.cue-row .cue-owner strong'))
      .hasText('周启', '负责人已从锁定版恢复');
  });

  test('前置引用找不到对应提示时整批拦住', async function (this: RenderingTestContext, assert) {
    await render(hbs`<CueEditor />`);

    await click(buttonByText(this.element, '打开恢复台'));
    // 彩排锁定版中 cue-sound-1 的前置 cue-deleted-old 在当前演出表已删除
    await click(restoreCheckboxes(this.element)[2]!);

    assert.dom('.restore-problems').exists('待应用区显示拦住原因');
    assert.dom('.restore-problems').includesText('找不到对应提示');
    assert.true(
      buttonByText(this.element, '应用恢复').disabled,
      '应用按钮被拦住',
    );
    assert.dom('.cue-row').exists({ count: 4 }, '整批未应用');

    await click(restoreCheckboxes(this.element)[3]!); // 同批补回被依赖的提示
    assert.dom('.restore-problems').doesNotExist('同批补回后校验通过');
    assert.false(buttonByText(this.element, '应用恢复').disabled);
  });
});
