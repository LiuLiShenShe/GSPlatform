import { useState } from 'react';
import { Button, Input } from 'antd';
import { SearchOutlined } from '@ant-design/icons';

interface SearchBoxProps {
  placeholder?: string;
  initialValue?: string;
  onSearch: (keyword: string) => void;
}

/**
 * 搜索框：Enter 键或按钮提交；value 非空时显示带 aria-label 的清空按钮（可键盘操作）。
 */
export function SearchBox({
  placeholder = '搜索场景、作者…',
  initialValue = '',
  onSearch,
}: SearchBoxProps) {
  const [value, setValue] = useState(initialValue);

  const submit = (): void => onSearch(value.trim());
  const clear = (): void => {
    setValue('');
    onSearch('');
  };

  return (
    <div className="gs-searchbox" role="search">
      <Input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onPressEnter={submit}
        prefix={<SearchOutlined aria-hidden />}
        placeholder={placeholder}
        aria-label={placeholder}
        suffix={
          value ? (
            <Button
              type="text"
              size="small"
              aria-label="清空搜索"
              className="gs-searchbox__clear"
              onClick={clear}
            >
              ✕
            </Button>
          ) : null
        }
      />
      <Button type="primary" onClick={submit} aria-label="提交搜索">
        搜索
      </Button>
    </div>
  );
}