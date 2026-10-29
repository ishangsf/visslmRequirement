import { Button, Collapse, Form, Input, Select, Typography } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { PushFixedParameter, PushUserMapping, PushValueOptions } from '../../shared/types'
import { ResizableTable } from './ResizableTable'

const scrollY = 'min(280px, max(160px, calc(100vh - 460px)))'

export function PushValueOptionsEditor({ value, targetFields, onChange }: {
  value: PushValueOptions
  targetFields: string[]
  onChange: (value: PushValueOptions) => void
}): React.JSX.Element {
  const users = value.userMappings ?? []
  const fixed = value.fixedParameters ?? []
  const updateUser = (id: string, patch: Partial<PushUserMapping>) => onChange({
    ...value, userMappings: users.map((row) => row.id === id ? { ...row, ...patch } : row)
  })
  const updateFixed = (id: string, patch: Partial<PushFixedParameter>) => onChange({
    ...value, fixedParameters: fixed.map((row) => row.id === id ? { ...row, ...patch } : row)
  })
  return <Collapse className="push-value-options" items={[
    {
      key: 'users', label: `用户登录名映射（${users.length} 组）`,
      children: <div className="push-value-options-content">
        <Typography.Text type="secondary">
          在字段名映射后转换指定字段的用户值。精确匹配、区分大小写；支持文本、数组及逗号/分号/换行分隔的多用户。源数据保持不变。
        </Typography.Text>
        <Form layout="vertical">
          <Form.Item label="需要转换的目标字段 Key" extra="例如 RAO → Devs 时填写 Devs。可选择已有目标字段，也可输入后按回车；点号按完整 Key 处理。">
            <Select mode="tags" aria-label="需要转换的目标字段 Key" value={value.userMappingFields ?? []}
              options={[...new Set(targetFields.map((field) => field.trim()).filter(Boolean))].map((field) => ({ value: field, label: field }))}
              onChange={(fields) => onChange({ ...value, userMappingFields: fields })} />
          </Form.Item>
          <Form.Item label="未匹配用户">
            <Select aria-label="未匹配用户" style={{ width: 240 }} value={value.unmappedUserPolicy ?? 'error'}
              options={[{ value: 'error', label: '阻止推送并提示（默认）' }, { value: 'keep', label: '保留原值继续推送' }]}
              onChange={(policy) => onChange({ ...value, unmappedUserPolicy: policy })} />
          </Form.Item>
        </Form>
        <Button icon={<PlusOutlined />} onClick={() => onChange({ ...value, userMappings: [...users, {
          id: crypto.randomUUID(), sourceLogin: '', targetLogin: ''
        }] })}>新增用户映射</Button>
        <ResizableTable<PushUserMapping> tableKey="push-user-mappings-v1" rowKey="id" dataSource={users}
          pagination={false} scroll={{ x: 600, y: scrollY }} locale={{ emptyText: '暂无用户映射' }} columns={[
            { title: '源平台登录名', dataIndex: 'sourceLogin', width: 240, render: (_, row) =>
              <Input aria-label="源平台登录名" value={row.sourceLogin} placeholder="例如：zhangsan.ext"
                onChange={(event) => updateUser(row.id, { sourceLogin: event.target.value })} /> },
            { title: '内网登录名 / 能力名', dataIndex: 'targetLogin', width: 280, render: (_, row) =>
              <Input aria-label="内网登录名或能力名" value={row.targetLogin} placeholder="例如：zhangsan.internal"
                onChange={(event) => updateUser(row.id, { targetLogin: event.target.value })} /> },
            { title: '操作', key: 'action', width: 80, render: (_, row) =>
              <Button type="text" danger aria-label="删除用户映射" icon={<DeleteOutlined />}
                onClick={() => onChange({ ...value, userMappings: users.filter((item) => item.id !== row.id) })} /> }
          ]} />
      </div>
    },
    {
      key: 'fixed', label: `额外固定参数（${fixed.length} 项）`,
      children: <div className="push-value-options-content">
        <Typography.Text type="secondary">
          每条记录都会附加这些参数。请求体固定值覆盖同名字段，作为最终值不再做用户映射；URL 参数不能覆盖认证及新建位置参数。文本保留原样；JSON 可填写数字、布尔值、数组、对象或 null。
        </Typography.Text>
        <Button icon={<PlusOutlined />} onClick={() => onChange({ ...value, fixedParameters: [...fixed, {
          id: crypto.randomUUID(), location: 'body', key: '', valueType: 'text', value: ''
        }] })}>新增固定参数</Button>
        <ResizableTable<PushFixedParameter> tableKey="push-fixed-parameters-v1" rowKey="id" dataSource={fixed}
          pagination={false} scroll={{ x: 820, y: scrollY }} locale={{ emptyText: '暂无固定参数' }} columns={[
            { title: '参数位置', dataIndex: 'location', width: 160, render: (_, row) =>
              <Select aria-label="固定参数位置" style={{ width: 128 }} value={row.location}
                options={[{ value: 'body', label: '请求体' }, { value: 'query', label: 'URL 参数' }]}
                onChange={(location) => updateFixed(row.id, { location, ...(location === 'query' ? { valueType: 'text' } : {}) })} /> },
            { title: '参数 Key', dataIndex: 'key', width: 180, render: (_, row) =>
              <Input aria-label="固定参数 Key" value={row.key} placeholder="例如：Priority"
                onChange={(event) => updateFixed(row.id, { key: event.target.value })} /> },
            { title: '值类型', dataIndex: 'valueType', width: 140, render: (_, row) =>
              <Select aria-label="固定参数值类型" style={{ width: 108 }} value={row.valueType} disabled={row.location === 'query'}
                options={[{ value: 'text', label: '文本' }, { value: 'json', label: 'JSON' }]}
                onChange={(valueType) => updateFixed(row.id, { valueType })} /> },
            { title: '固定值', dataIndex: 'value', width: 260, render: (_, row) =>
              <Input.TextArea aria-label="固定参数值" autoSize={{ minRows: 1, maxRows: 4 }} value={row.value}
                placeholder={row.valueType === 'json' ? '例如：true、3、["A","B"]' : '文本值（允许空字符串）'}
                onChange={(event) => updateFixed(row.id, { value: event.target.value })} /> },
            { title: '操作', key: 'action', width: 80, render: (_, row) =>
              <Button type="text" danger aria-label="删除固定参数" icon={<DeleteOutlined />}
                onClick={() => onChange({ ...value, fixedParameters: fixed.filter((item) => item.id !== row.id) })} /> }
          ]} />
      </div>
    }
  ]} />
}
