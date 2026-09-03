import React from 'react';

export type OverlayState = 'scanning' | 'detected' | 'locked';

interface ScanOverlayProps {
  state: OverlayState;
  barcodePosition?: { x: number; y: number; width: number; height: number } | null;
}

// CornerFrame 组件：四角取景框
const CornerFrame: React.FC<{ state: OverlayState }> = ({ state }) => {
  const isScanning = state === 'scanning';
  const isDetected = state === 'detected';

  // scanning 绿色，detected/locked 金色
  const color = isScanning ? '#35D07F' : '#FFC700';

  return (
    <div className="absolute inset-[12%] w-[76%] h-[76%]">
      {/* 左上角 */}
      <div
        className="absolute top-0 left-0 w-8 h-8"
        style={{
          borderTop: `3px solid ${color}`,
          borderLeft: `3px solid ${color}`,
          borderTopLeftRadius: 4,
          animation: isScanning
            ? 'breathe 1.5s ease-in-out infinite'
            : isDetected
            ? 'barcodeFound 0.3s ease-out forwards, breathe 1.5s ease-in-out 0.3s infinite'
            : 'none',
        }}
      />
      {/* 右上角 */}
      <div
        className="absolute top-0 right-0 w-8 h-8"
        style={{
          borderTop: `3px solid ${color}`,
          borderRight: `3px solid ${color}`,
          borderTopRightRadius: 4,
          animation: isScanning
            ? 'breathe 1.5s ease-in-out infinite'
            : isDetected
            ? 'barcodeFound 0.3s ease-out forwards, breathe 1.5s ease-in-out 0.3s infinite'
            : 'none',
        }}
      />
      {/* 左下角 */}
      <div
        className="absolute bottom-0 left-0 w-8 h-8"
        style={{
          borderBottom: `3px solid ${color}`,
          borderLeft: `3px solid ${color}`,
          borderBottomLeftRadius: 4,
          animation: isScanning
            ? 'breathe 1.5s ease-in-out infinite'
            : isDetected
            ? 'barcodeFound 0.3s ease-out forwards, breathe 1.5s ease-in-out 0.3s infinite'
            : 'none',
        }}
      />
      {/* 右下角 */}
      <div
        className="absolute bottom-0 right-0 w-8 h-8"
        style={{
          borderBottom: `3px solid ${color}`,
          borderRight: `3px solid ${color}`,
          borderBottomRightRadius: 4,
          animation: isScanning
            ? 'breathe 1.5s ease-in-out infinite'
            : isDetected
            ? 'barcodeFound 0.3s ease-out forwards, breathe 1.5s ease-in-out 0.3s infinite'
            : 'none',
        }}
      />
    </div>
  );
};

// ScanLine 组件：扫描线动画
const ScanLine: React.FC = () => (
  <div
    className="absolute left-[20%] right-[20%] h-[2px]"
    style={{
      top: '20%',
      backgroundColor: '#35D07F',
      opacity: 0.6,
      animation: 'scanLineMove 2s linear infinite',
      boxShadow: '0 0 8px 2px rgba(53, 208, 127, 0.4)',
    }}
  />
);

// 条码位置标识
const BarcodeIndicator: React.FC<{
  position: { x: number; y: number; width: number; height: number };
}> = ({ position }) => (
  <div
    className="absolute"
    style={{
      left: `${position.x}%`,
      top: `${position.y}%`,
      width: `${position.width}%`,
      height: `${position.height}%`,
      border: '1px solid #35D07F',
      borderRadius: 2,
    }}
  />
);

const ScanOverlay: React.FC<ScanOverlayProps> = ({ state, barcodePosition }) => {
  const showScanLine = state === 'scanning';
  const showBarcodeIndicator =
    barcodePosition != null && state !== 'scanning';

  return (
    <>
      <style>{`
        @keyframes breathe {
          0%, 100% { opacity: 0.6; }
          50% { opacity: 1; }
        }

        @keyframes barcodeFound {
          0% { opacity: 1; }
          50% { opacity: 1; filter: drop-shadow(0 0 8px #FFC700); }
          100% { opacity: 1; }
        }

        @keyframes scanLineMove {
          0% { top: 20%; }
          100% { top: 70%; }
        }
      `}</style>

      <div className="absolute inset-0 pointer-events-none">
        <CornerFrame state={state} />
        {showScanLine && <ScanLine />}
        {showBarcodeIndicator && <BarcodeIndicator position={barcodePosition!} />}
      </div>
    </>
  );
};

export type { ScanOverlayProps };
export { ScanOverlay };
