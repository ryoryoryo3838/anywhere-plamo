#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10,<3.14"
# dependencies = ["BabelDOC==0.7.1"]
# ///
"""Translate a PDF with BabelDOC and a local PLaMo llama-server."""

import argparse
from http.client import HTTPConnection
from importlib import metadata
import json
import os
from pathlib import Path
import re
import sys
import tempfile

TARGETS = ('ja', 'en', 'ko', 'zh-hans', 'fr', 'de', 'es')
BABELDOC_VERSION = '0.7.1'
MODEL = 'plamo-3-translate'


def loopback_port(url):
    match = re.fullmatch(r'http://127\.0\.0\.1:([0-9]{1,5})/?', url)
    if not match or not 1 <= int(match[1]) <= 65535:
        raise argparse.ArgumentTypeError('expected http://127.0.0.1:PORT')
    return int(match[1])


def prompt(text, target):
    if target not in TARGETS or not text.strip() or '<|plamo:' in text:
        raise ValueError('invalid target, empty paragraph, or reserved PLaMo control token')
    if len(text.encode('utf-16-le')) > 24_000:
        raise ValueError('paragraph exceeds the 12,000 UTF-16 character limit')
    return ('<|plamo:tag|>dataset<|plamo:msg|>translation'
            f'<|plamo:tag|>input<|plamo:msg|>{text}'
            f'<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>{target}<|plamo:msg|>')


class LocalCompletion:
    def __init__(self, port, target, key):
        self.port = port
        self.target = target
        self.key = key
        self.failure = None
        self.translated = False

    def post(self, path, payload):
        # Direct connection: no DNS, environment proxies or redirect following.
        conn = HTTPConnection('127.0.0.1', self.port, timeout=600)
        try:
            headers = {'Content-Type': 'application/json'}
            if self.key:
                headers['Authorization'] = 'Bearer ' + self.key
            conn.request('POST', path, json.dumps(payload).encode(), headers)
            response = conn.getresponse()
            if response.status != 200:
                raise RuntimeError(f'local server {path}: HTTP {response.status}')
            return json.loads(response.read(1_048_577))
        finally:
            conn.close()

    def translate(self, text):
        # BabelDOC may catch a paragraph error and render its source instead.
        # Remember it independently; never publish such a PDF as a success.
        self.check_failure()
        try:
            source = prompt(text, self.target)
            tokens = self.post('/tokenize', {'content': source, 'add_special': True,
                                             'parse_special': True})['tokens']
            if not isinstance(tokens, list) or not 0 < len(tokens) <= 4096:
                raise ValueError('invalid token count or paragraph exceeds the 4096-token limit')
            reply = self.post('/v1/completions', {
                'model': MODEL, 'prompt': source, 'temperature': 0, 'stream': False,
                'max_tokens': 8192 - len(tokens), 'stop': ['<|plamo:tag|>', '<|plamo:bos|>'],
            })['choices'][0]
            result = reply['text']
            if reply.get('finish_reason') != 'stop' or not isinstance(result, str) or not result.strip():
                raise ValueError('local server returned an incomplete or empty translation')
            self.translated = True
            return result
        except Exception as exc:
            self.failure = exc
            raise

    def check_failure(self):
        if self.failure is not None:
            raise RuntimeError(f'paragraph translation failed: {self.failure}') from self.failure


def make_translator(completion):
    from babeldoc.translator.translator import BaseTranslator

    class PLaMoTranslator(BaseTranslator):
        name = 'local-plamo'
        model = MODEL

        def do_translate(self, text, rate_limit_params=None):
            return completion.translate(text)

        def do_llm_translate(self, text, rate_limit_params=None):
            # Capability probe: PLaMo consumes native prompts, not chat instructions.
            raise NotImplementedError

    return PLaMoTranslator('auto', completion.target, ignore_cache=True)


def translate_pdf(source, output, target, port, preview_dir=None):
    if not source.is_file() or source.resolve() == output.resolve():
        raise ValueError('input must be a file distinct from output')
    if metadata.version('BabelDOC') != BABELDOC_VERSION:
        raise RuntimeError(f'install BabelDOC=={BABELDOC_VERSION} in the selected Python environment')
    from babeldoc.format.pdf.high_level import translate
    from babeldoc.format.pdf.translation_config import TranslationConfig

    completion = LocalCompletion(port, target, os.environ.get('ANYWHERE_PLAMO_API_KEY'))
    with tempfile.TemporaryDirectory(prefix='.babeldoc-', dir=output.parent) as tmp:
        config_type = TranslationConfig
        split_strategy = None
        if preview_dir is not None:
            import shutil
            from babeldoc.format.pdf.split_manager import PageCountStrategy

            preview_dir.mkdir(mode=0o700, exist_ok=True)
            if any(preview_dir.iterdir()):
                raise ValueError('preview directory must be empty')

            def publish(page, path):
                staging = preview_dir / f'{page}.partial'
                shutil.copyfile(path, staging)
                staging.replace(preview_dir / f'{page}.pdf')

            # In 0.7.1 this hook runs after the part writer closes, before the
            # native merger consumes its output. Never read a half-written PDF.
            class PreviewConfig(TranslationConfig):
                def cleanup_part_working_dir(self, index):
                    try:
                        if sys.exc_info()[0] is None:
                            completion.check_failure()
                            part, = self.get_part_output_dir(index).glob('*.mono.pdf')
                            publish(index + 1, part)
                    finally:
                        super().cleanup_part_working_dir(index)

            config_type = PreviewConfig
            split_strategy = PageCountStrategy(1)
        config = config_type(
            split_strategy=split_strategy, skip_scanned_detection=True,
            translator=make_translator(completion), input_file=source.resolve(), lang_in='auto',
            lang_out={'ko': 'ko-KR', 'zh-hans': 'zh-CN'}.get(target, target),
            doc_layout_model=None, working_dir=Path(tmp) / 'work', output_dir=Path(tmp) / 'out',
            no_dual=True, auto_extract_glossary=False, save_auto_extracted_glossary=False,
            qps=1, pool_max_workers=1, min_text_length=1, use_rich_pbar=False,
        )
        result = translate(config)
        completion.check_failure()
        if not completion.translated:
            raise RuntimeError('no translatable paragraphs were found')
        if not result or not result.mono_pdf_path or not Path(result.mono_pdf_path).is_file():
            raise RuntimeError('BabelDOC did not produce a monolingual PDF')
        if preview_dir is not None and not (preview_dir / '1.pdf').exists():
            publish(1, result.mono_pdf_path)  # BabelDOC bypasses splitting for a single page.
        os.replace(result.mono_pdf_path, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', metavar='INPUT', type=Path)
    parser.add_argument('output', metavar='OUTPUT', type=Path)
    parser.add_argument('--target', required=True, choices=TARGETS)
    parser.add_argument('--server-url', required=True, type=loopback_port, metavar='http://127.0.0.1:PORT')
    parser.add_argument('--preview-dir', type=Path, help='publish each finished page in this empty directory')
    args = parser.parse_args()
    try:
        translate_pdf(args.input, args.output, args.target, args.server_url, args.preview_dir)
    except metadata.PackageNotFoundError:
        parser.exit(1, f'Install BabelDOC=={BABELDOC_VERSION} in the selected Python environment.\n')
    except Exception as exc:
        parser.exit(1, f'PDF translation failed: {exc}\n')


if __name__ == '__main__':
    main()
