import * as Switch from '@radix-ui/react-switch';
import { type Ref, useId } from 'react';

/**
 * 统一侧栏设置开关的语义、焦点和浏览器外观样式。
 *
 * @param props.label 屏幕阅读器和可见界面共用的名称。
 * @param props.checked 已确认的开关状态。
 * @param props.disabled 等待持久结果时禁止重复操作。
 * @param props.buttonRef 进入控件导航时可直接聚焦的开关按钮。
 * @param props.onCheckedChange 用户切换后的回调。
 */
export function SettingSwitch({
  label,
  checked,
  disabled = false,
  buttonRef,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  onCheckedChange(value: boolean): void;
}) {
  const id = useId();
  return (
    <div className="setting-switch-row" data-native-keyboard>
      <label htmlFor={id}>{label}</label>
      <Switch.Root
        aria-label={label}
        checked={checked}
        className="setting-switch"
        disabled={disabled}
        id={id}
        onCheckedChange={onCheckedChange}
        ref={buttonRef}
      >
        <Switch.Thumb className="setting-switch-thumb" />
      </Switch.Root>
    </div>
  );
}
