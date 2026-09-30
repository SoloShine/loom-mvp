// schema→form 渲染器（design 取舍表：params 表单与 ui.ask 共用同一渲染器）。
// 字段类型 string / number / boolean / select；label 与 required 标记由
// UiField 携带；值的类型化与校验在 ui-logic.ts（纯函数，单测覆盖）。
//
// 受控组件约定：number 字段编辑期存原始串（不清用户的半截输入），提交前
// 经 finalizeFormValues 定型。

import type { ReactElement } from "react";
import type { UiField } from "../actions/ui";
import { valueToInput, type FormValues } from "../ui-logic";

export function SchemaForm(props: {
  fields: UiField[];
  values: FormValues;
  onChange: (name: string, value: unknown) => void;
}): ReactElement {
  const { fields, values, onChange } = props;
  return (
    <div className="form">
      {fields.map((f) => {
        const label = (f.label ?? f.name) + (f.required ? " *" : "");
        if (f.type === "boolean") {
          return (
            <label key={f.name} className="field field-bool">
              <input
                type="checkbox"
                checked={values[f.name] === true}
                onChange={(e) => onChange(f.name, e.target.checked)}
              />
              <span>{label}</span>
            </label>
          );
        }
        if (f.type === "select") {
          return (
            <label key={f.name} className="field">
              <span className="field-label">{label}</span>
              <select value={valueToInput(values[f.name])} onChange={(e) => onChange(f.name, e.target.value)}>
                {(f.options ?? []).map((o) => {
                  const value = typeof o === "string" ? o : o.value;
                  const text = typeof o === "string" ? o : (o.label ?? o.value);
                  return (
                    <option key={value} value={value}>
                      {text}
                    </option>
                  );
                })}
              </select>
            </label>
          );
        }
        return (
          <label key={f.name} className="field">
            <span className="field-label">{label}</span>
            <input
              type={f.type === "number" ? "number" : "text"}
              value={valueToInput(values[f.name])}
              onChange={(e) => onChange(f.name, e.target.value)}
            />
          </label>
        );
      })}
    </div>
  );
}
