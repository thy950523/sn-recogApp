# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## 识别优化样本

拍照、相册导入和连续扫描会将需要人工核对的图片保存到项目目录
`tmp/recognition-samples/YYYY-MM-DD/`（日期按 UTC），供后续优化识别算法：

- 包含仅 OCR、待人工确认、条码与 OCR 不一致、仅条码、完全未识别及推断候选。
- 多设备照片中任一候选符合条件，保存整张图；全部双验证一致的照片不保存。
- 每次识别保存一个图片文件和同名 JSON，记录保存原因、OCR 文本、候选或条码、引擎和图像尺寸。
- 导入图片保留原始文件；没有原始文件时保存完整画布 PNG。连续扫描保存当次 OCR 对应的固定帧。
- 此目录已加入 Git 忽略列表，不设 50 张上限，不会随重拍、清空登记记录而删除；可手动清理。
- 设置 Python 服务的 `OCR_SAMPLES_DIR` 环境变量可更换目录；`GET /health` 返回实际 `sampleDir`。
- 需运行更新后的 Python OCR 服务（默认 3458 端口）。单次样本上传上限为 64 MiB（含元数据）；保存失败会在页面提示，识别与登记仍可继续，失败的上传不会自动补传。

更新代码后需重启 Python 服务：`./stop.sh` 后执行 `./start.sh`。

验证样本写入：`cd ocr-server && python3 -m unittest test_sample_store.py`。

## 查看图片、裁剪与 Excel 体积

识别完成后点击「查看与裁剪」，可在完整原图上查看全部 OCR 文字框、放大滚动、对照文字列表，并手动框选需要的部分。也可以点击「按全部文字框裁剪」，自动包含全部文字框并留出边距。黄色框代表将用于导出的区域；点击「应用到导出图片」保存设置。

登记记录中每张图片都有裁剪入口，可对每条记录分别调整。原始图片始终完整保留；恢复整图后重新导出即可。新登记记录保存全部 OCR 文字框；没有坐标的旧记录仍支持手动裁剪。

Excel 默认使用「精简图片」（长边最多 1280 px，约 180 KB/张为压缩目标），也可选择「清晰图片」「原图画质」或「仅文字」。压缩在导出时进行，不覆盖原图。相同原图与裁剪范围在 Excel 内仅嵌入一次，不同裁剪范围分别嵌入；导出完成后显示实际文件大小。复杂图片可能超过单张压缩目标，压缩后请检查文字是否清晰。图片仍沿用 WPS 的 DISPIMG 单元格格式。
