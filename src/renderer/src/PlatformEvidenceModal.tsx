import { Collapse, Descriptions, Modal, Typography } from 'antd'
import type { ChatSource } from '../../shared/types'

export const PlatformEvidenceModal = ({ source, onClose }: { source: ChatSource | null; onClose: () => void }) => (
  <Modal className="chat-data-modal" open={Boolean(source)} onCancel={onClose} footer={null}
    width="min(960px, calc(100vw - 32px))" centered destroyOnHidden
    title={<span style={{ display: 'block', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>平台实时记录 · {source?.name}</span>}
    styles={{ body: { minHeight: 0, maxHeight: 'calc(100vh - 200px)', overflowY: 'auto', color: 'var(--text-main)' } }}>
    <Descriptions size="small" column={2} items={[
      { key: 'type', label: '数据类型', children: source?.nodeType },
      { key: 'id', label: '业务编号', children: source?.itemId },
      { key: 'time', label: '读取时间', children: source?.platformSnapshot?.fetchedAt, span: 2 }
    ]} />
    <Typography.Paragraph type="secondary">这是本次平台查询用于回答的正文快照；过长内容已省略，未写入本地数据中心。</Typography.Paragraph>
    <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 16, borderRadius: 8, background: 'var(--surface-soft)' }}>
      {source?.platformSnapshot?.text || '本次查询没有返回可读正文。'}
    </div>
    <Collapse style={{ marginTop: 16 }} items={[{ key: 'fields', label: '查看本次返回字段', children:
      <pre style={{ maxHeight: 'calc(100vh - 360px)', minHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'var(--surface-soft)', color: 'var(--text-main)', padding: 12 }}>
        {JSON.stringify(source?.platformSnapshot?.fields ?? {}, null, 2)}
      </pre>
    }]} />
  </Modal>
)
