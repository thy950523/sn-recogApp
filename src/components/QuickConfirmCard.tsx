import React, { useEffect, useRef, useState } from 'react';
import type { ImeiField, MatchedField } from '@/types';

export type CardStatus = 'pending' | 'verified' | 'warning' | 'ocr_waiting' | 'duplicate';

interface QuickConfirmCardProps {
  /** 已与 OCR 匹配的条码（即最终 SN，可为 null） */
  matchedBarcode: string | null;
  /** 画面中识别到的全部条码 */
  barcodeList: string[];
  /** 状态 */
  status: CardStatus;
  /** OCR 识别的原始文本（可选） */
  ocrText?: string | null;
  /** OCR 提取到的 SN（通过 S/N: 标记） */
  ocrSn?: string | null;
  /** OCR 提取到的 IMEI（已按 IMEI1/IMEI2 排序） */
  imeis?: ImeiField[];
  /** OCR 提取到的 MEID */
  meid?: MatchedField | null;
  /** OCR 提取到的 EID */
  eid?: MatchedField | null;
  onRegister: () => void;
  onDismiss: () => void;
}

const STATUS_CONFIG: Record<
  CardStatus,
  { label: string; colorClass: string }
> = {
  pending:     { label: 'OCR 验证中...',   colorClass: 'text-green-400' },
  verified:    { label: 'OCR ✓ 验证通过', colorClass: 'text-green-400' },
  warning:     { label: 'OCR ✗ 待复核',   colorClass: 'text-amber-400' },
  ocr_waiting: { label: 'OCR 等待中...',  colorClass: 'text-gray-400' },
  duplicate:   { label: '已存在',          colorClass: 'text-[#555]' },
};

const QuickConfirmCard: React.FC<QuickConfirmCardProps> = ({
  matchedBarcode,
  barcodeList,
  status,
  ocrText,
  ocrSn,
  imeis,
  meid,
  eid,
  onRegister,
  onDismiss,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [showOcrRaw, setShowOcrRaw] = useState(false);

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.style.transform = 'translateY(0)';
    });
    // 每次出现时重置折叠状态
    setShowOcrRaw(false);
  }, [ocrText]);


  return (
    <>
      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); }
          to   { transform: translateY(0);    }
        }
      `}</style>

      <div
        ref={cardRef}
        className="absolute inset-x-4 bottom-24 bg-black/90 border border-yellow-400 p-4"
        style={{
          transform: 'translateY(100%)',
          transition: 'transform 300ms ease-out',
        }}
      >
        {/* 全部条码列表 */}
        <div className="space-y-1 mb-3">
          {barcodeList.map((code, i) => {
            const isMatched = code === matchedBarcode;
            return (
              <div
                key={i}
                className={`font-mono text-sm text-center tracking-widest ${
                  isMatched
                    ? 'text-yellow-400'
                    : 'text-gray-500'
                }`}
              >
                {isMatched ? '✓ ' : '  '}
                <span className="text-[9px] text-[#555] mr-1">条形码 {i + 1}</span>
                {code}
              </div>
            );
          })}
        </div>

        {/* OCR 提取的 SN（最核心信息，高亮显示） */}
        {ocrSn && (
          <div className="mb-3 border-t border-[#2a2a2a] pt-2">
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-[9px] text-[#ffc700] tracking-widest uppercase">SN</span>
              <span className="font-mono text-base font-bold tracking-widest text-white">
                {ocrSn}
              </span>
              {ocrSn === matchedBarcode ? (
                <span className="font-mono text-[9px] text-green-400">✓ 与条码一致</span>
              ) : matchedBarcode ? (
                <span className="font-mono text-[9px] text-amber-400">⚠ 与条码不符</span>
              ) : null}
            </div>
          </div>
        )}

        {/* OCR 提取的设备标识（IMEI / MEID / EID） */}
        {((imeis && imeis.length > 0) || meid || eid) && (
          <div className="space-y-1 mb-3 border-t border-[#2a2a2a] pt-2">
            {imeis?.map((f, i) => (
              <div
                key={`imei-${i}`}
                className={`font-mono text-[11px] text-center tracking-wider ${
                  f.matchedBarcode ? 'text-green-400' : 'text-gray-400'
                }`}
              >
                {f.matchedBarcode ? '✓ ' : '  '}
                <span className="text-[9px] text-[#555] mr-1">
                  {f.slot ? `IMEI${f.slot}` : i === 0 ? 'IMEI1' : `IMEI${i + 1}`}
                </span>
                {f.value}
              </div>
            ))}
            {meid && (
              <div className={`font-mono text-[11px] text-center tracking-wider ${meid.matchedBarcode ? 'text-green-400' : 'text-gray-400'}`}>
                {meid.matchedBarcode ? '✓ ' : '  '}
                <span className="text-[9px] text-[#555] mr-1">MEID</span>
                {meid.value}
              </div>
            )}
            {eid && (
              <div className={`font-mono text-[10px] text-center tracking-wide break-all ${eid.matchedBarcode ? 'text-green-400' : 'text-gray-500'}`}>
                {eid.matchedBarcode ? '✓ ' : '  '}
                <span className="text-[9px] text-[#555] mr-1">EID</span>
                {eid.value}
              </div>
            )}
          </div>
        )}

        {/* OCR 原文：默认收起，用户可手动展开 */}
        {ocrText && (
          <div className="mb-3 border border-[#2a2a2a] bg-[#0d0d0d]">
            <button
              type="button"
              onClick={() => setShowOcrRaw(v => !v)}
              className="flex w-full items-center justify-between px-3 py-2"
            >
              <span className="font-mono text-[9px] text-[#555] uppercase tracking-widest">OCR 原文</span>
              <span className="font-mono text-[9px] text-[#ffc700]">
                {showOcrRaw ? '收起 −' : '展开 +'}
              </span>
            </button>
            {showOcrRaw && (
              <div className="border-t border-[#2a2a2a] px-3 py-2">
                <p className="font-mono text-xs leading-4 tracking-wide text-[#c9c9c9] break-all">
                  {ocrText}
                </p>
              </div>
            )}
          </div>
        )}

        {/* 状态行 */}
        <p className={`text-sm text-center mb-4 ${STATUS_CONFIG[status].colorClass}`}>
          {STATUS_CONFIG[status].label}
        </p>

        {/* 双按钮（重复时只显示忽略） */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onDismiss}
            className="flex-1 py-3 border border-gray-600 text-gray-400 font-mono tracking-widest"
          >
            忽 略
          </button>
          {status !== 'duplicate' && (
            <button
              type="button"
              onClick={onRegister}
              className="flex-1 py-3 bg-yellow-400 text-black font-mono tracking-widest font-bold"
            >
              登 记
            </button>
          )}
        </div>
      </div>
    </>
  );
};

export { QuickConfirmCard };
export type { QuickConfirmCardProps };
