"""Recognition sample archive. Standard library only; independent of OCR models."""
import json
import os
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from pathlib import Path
from uuid import uuid4

SAMPLE_DIR = Path(os.environ.get('OCR_SAMPLES_DIR') or Path(__file__).resolve().parent.parent / 'tmp' / 'recognition-samples')
MAX_SAMPLE_BYTES = 64 * 1024 * 1024


def save_sample(content_type, body, directory=None):
    if not content_type.startswith('multipart/form-data;'):
        raise ValueError('需要 multipart/form-data')
    message = BytesParser(policy=policy.default).parsebytes(
        f'Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n'.encode() + body
    )
    parts = {p.get_param('name', header='content-disposition'): p for p in message.iter_parts()}
    if 'image' not in parts or 'metadata' not in parts:
        raise ValueError('缺少 image 或 metadata')
    image = parts['image'].get_payload(decode=True)
    if not image:
        raise ValueError('图片数据为空')
    metadata = json.loads(parts['metadata'].get_payload(decode=True).decode('utf-8'))
    if not isinstance(metadata, dict) or not metadata.get('reasons'):
        raise ValueError('缺少样本保存原因')
    mime = parts['image'].get_content_type()
    extension = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
                 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic',
                 'image/heif': 'heif', 'image/svg+xml': 'svg', 'image/gif': 'gif'}.get(mime, 'bin')
    now = datetime.now(timezone.utc)
    folder = Path(directory or SAMPLE_DIR) / now.strftime('%Y-%m-%d')
    folder.mkdir(parents=True, exist_ok=True)
    stem = now.strftime('%H%M%S-%f') + '-' + uuid4().hex
    image_path = folder / f'{stem}.{extension}'
    metadata_path = folder / f'{stem}.json'
    try:
        image_path.write_bytes(image)
        metadata_path.write_text(json.dumps({**metadata, 'savedAt': now.isoformat(),
                                             'imageFile': image_path.name, 'mimeType': mime},
                                            ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        image_path.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)
        raise
    return {'ok': True, 'imageFile': str(image_path.relative_to(Path(directory or SAMPLE_DIR)))}
