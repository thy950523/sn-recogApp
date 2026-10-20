import json
import tempfile
import unittest
from pathlib import Path
from sample_store import save_sample


def multipart(image=b'\x89PNG\r\n\x1a\noriginal', metadata=None):
    metadata = metadata if metadata is not None else {'reasons': ['ocr_only'], 'rawText': '中文 S/N:AB123456'}
    body = (b'--test-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n'
            + json.dumps(metadata, ensure_ascii=False).encode() + b'\r\n'
            + b'--test-boundary\r\nContent-Disposition: form-data; name="image"; filename="../../bad.png"\r\n'
            + b'Content-Type: image/png\r\n\r\n' + image + b'\r\n--test-boundary--\r\n')
    return 'multipart/form-data; boundary=test-boundary', body


class SampleStoreTests(unittest.TestCase):
    def test_original_bytes_and_metadata_are_paired_without_filename_collisions(self):
        with tempfile.TemporaryDirectory() as folder:
            first = save_sample(*multipart(), directory=folder)
            second = save_sample(*multipart(), directory=folder)
            self.assertNotEqual(first['imageFile'], second['imageFile'])
            image = Path(folder) / first['imageFile']
            self.assertEqual(image.read_bytes(), b'\x89PNG\r\n\x1a\noriginal')
            metadata = json.loads(image.with_suffix('.json').read_text())
            self.assertEqual(metadata['rawText'], '中文 S/N:AB123456')
            self.assertEqual(metadata['imageFile'], image.name)
            self.assertTrue(image.resolve().is_relative_to(Path(folder).resolve()))
            self.assertEqual(len(list(Path(folder).rglob('*.png'))), 2)

    def test_invalid_samples_do_not_leave_files(self):
        with tempfile.TemporaryDirectory() as folder:
            for args in [multipart(image=b''), multipart(metadata={}), ('text/plain', b'bad'),
                         ('multipart/form-data; boundary=test', b'bad')]:
                with self.assertRaises(ValueError):
                    save_sample(*args, directory=folder)
            self.assertEqual(list(Path(folder).rglob('*')), [])


if __name__ == '__main__':
    unittest.main()
