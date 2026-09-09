import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Select, Space, Steps, Typography, Upload } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { App } from 'antd';
import { useBlocker } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import type { UploadFile, UploadProps } from 'antd';

const { Dragger } = Upload;

const ACCEPTED_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'jpg', 'jpeg', 'png', 'webp'];
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
const MAX_FILE_COUNT = 20;

interface ValidationResult {
  accepted: number;
  rejected: number;
}

/**
 * 免费计算页：三步流程（上传素材 → 参数确认 → 排队与计算）。
 * 后端（Phase 06/07）未接入：提交明确不可用，不伪造队列或进度；
 * 刷新 / 返回前对未保存输入给出提醒。
 */
export default function ComputePage() {
  useDocumentTitle('免费计算');
  const { message, modal } = App.useApp();

  const [step, setStep] = useState(0);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [quality, setQuality] = useState('标准');
  const [sceneType, setSceneType] = useState('室内');
  const [rightsChecked, setRightsChecked] = useState(false);
  const [validation, setValidation] = useState<ValidationResult>({
    accepted: 0,
    rejected: 0,
  });

  const hasUnsaved = fileList.length > 0 || rightsChecked;

  // 刷新 / 关闭前提醒
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (hasUnsaved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved]);

  // 站内跳转前提醒（React Router v7 useBlocker，配合 data router）
  const blocker = useBlocker(hasUnsaved);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      modal.confirm({
        title: '离开页面？',
        content: '当前选择的素材与参数尚未提交，离开后将丢失。',
        onOk: () => blocker.proceed(),
        onCancel: () => blocker.reset(),
      });
    }
  }, [blocker, modal]);

  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    const ext = (file.name.split('.').pop() ?? '').toLowerCase();
    const reasons: string[] = [];
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      reasons.push(`不支持扩展名 .${ext}`);
    }
    if (file.size > MAX_FILE_SIZE) {
      reasons.push('超过 1GB 大小限制');
    }
    if (reasons.length > 0) {
      setValidation((prev) => ({ ...prev, rejected: prev.rejected + 1 }));
      message.error(`${file.name}：${reasons.join('；')}`);
      return Upload.LIST_IGNORE;
    }
    return true;
  };

  const customRequest: UploadProps['customRequest'] = ({ onSuccess }) => {
    onSuccess?.({});
  };

  const handleChange: UploadProps['onChange'] = ({ fileList: next }) => {
    const limited = next.slice(0, MAX_FILE_COUNT);
    setFileList(limited);
    setValidation({ accepted: limited.length, rejected: validation.rejected });
  };

  const canNextToParams = fileList.length > 0;
  // 后端未接入：无论是否勾选权利，提交均不可用（理由随状态变化）。
  const submitDisabled = true;
  const submitHint = rightsChecked
    ? '计算服务将在 Phase 06/07 接入，当前阶段不可提交。'
    : '请先确认您拥有素材权利并同意处理规则。';

  return (
    <section aria-label="免费计算" style={{ maxWidth: 880 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        免费计算
      </Typography.Title>

      <Steps
        current={step}
        items={[
          { title: '上传素材' },
          { title: '参数确认' },
          { title: '排队与计算' },
        ]}
        style={{ marginBottom: 24 }}
      />

      {step === 0 && (
        <div>
          <Dragger
            multiple
            accept={ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',')}
            fileList={fileList}
            beforeUpload={beforeUpload}
            customRequest={customRequest}
            onChange={handleChange}
            maxCount={MAX_FILE_COUNT}
            aria-label="上传视频或照片序列"
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined aria-hidden />
            </p>
            <p className="ant-upload-text">拖入视频或照片序列</p>
            <p className="ant-upload-hint">
              支持 {ACCEPTED_EXTENSIONS.map((e) => e.toUpperCase()).join(' / ')}，单个不超过
              1GB，最多 {MAX_FILE_COUNT} 个文件。具体支持范围最终以服务端能力为准（Phase
              06 接入）。
            </p>
          </Dragger>

          {fileList.length > 0 && (
            <Alert
              style={{ marginTop: 12 }}
              type="info"
              showIcon
              message={`已选择 ${fileList.length} 个文件`}
              description={
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {fileList.map((file) => (
                    <li key={file.uid}>
                      {file.name}（{((file.size ?? 0) / 1024 / 1024).toFixed(1)} MB）
                    </li>
                  ))}
                </ul>
              }
            />
          )}
          {validation.rejected > 0 && (
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              showIcon
              message={`${validation.rejected} 个文件未通过前端初步校验`}
              description="不支持的扩展名或超过大小限制的文件已被忽略。"
            />
          )}

          <div style={{ marginTop: 24 }}>
            <Button type="primary" disabled={!canNextToParams} onClick={() => setStep(1)}>
              下一步：参数确认
            </Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <Space orientation="vertical" size={16} style={{ width: '100%', maxWidth: 360 }}>
            <label>
              <Typography.Text>质量</Typography.Text>
              <Select
                value={quality}
                onChange={setQuality}
                options={[
                  { value: '标准', label: '标准' },
                  { value: '高', label: '高' },
                ]}
                style={{ width: '100%' }}
                aria-label="质量"
              />
            </label>
            <label>
              <Typography.Text>场景类型</Typography.Text>
              <Select
                value={sceneType}
                onChange={setSceneType}
                options={[
                  { value: '室内', label: '室内' },
                  { value: '室外', label: '室外' },
                  { value: '物体', label: '物体' },
                ]}
                style={{ width: '100%' }}
                aria-label="场景类型"
              />
            </label>
            <Checkbox
              checked={rightsChecked}
              onChange={(event) => setRightsChecked(event.target.checked)}
            >
              我拥有素材权利并同意处理规则
            </Checkbox>
            <Alert
              type="info"
              showIcon
              message="提交计算服务尚未接入（Phase 06/07）"
              description="当前不会创建真实的队列任务或显示进度。"
            />
            <div>
              <Button style={{ marginRight: 12 }} onClick={() => setStep(0)}>
                上一步
              </Button>
              <Button
                type="primary"
                disabled={submitDisabled}
                title={submitHint}
                aria-describedby="compute-submit-hint"
                onClick={() => setStep(2)}
              >
                提交计算
              </Button>
              <span
                id="compute-submit-hint"
                style={{ display: 'block', marginTop: 8, color: 'var(--gs-text-tertiary)', fontSize: 12 }}
              >
                {submitHint}
              </span>
            </div>
          </Space>
        </div>
      )}

      {step === 2 && (
        <div>
          <Alert
            type="warning"
            showIcon
            message="尚未真正提交计算任务"
            description={
              <>
                后端计算与队列服务将在 Phase 06/07 接入。届时这里会显示真实任务状态（排队、
                处理中、完成），而不是占位说明。
                <br />
                已收集：{fileList.length} 个文件 · 质量 {quality} · 场景类型 {sceneType} ·
                权利确认{rightsChecked ? '已完成' : '未完成'}。
              </>
            }
          />
          <div style={{ marginTop: 24 }}>
            <Button style={{ marginRight: 12 }} onClick={() => setStep(1)}>
              上一步
            </Button>
            <Button onClick={() => window.history.back()}>返回</Button>
          </div>
        </div>
      )}
    </section>
  );
}