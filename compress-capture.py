#!/usr/bin/env python3
"""Transport a genuine capture as lossless decoded-RGB XOR/zlib frames.

Requires Python 3 and Pillow. This preserves decoded pixels and protocol
timestamps; it does not preserve the original JPEG bitstream. No network calls.

  python3 compress-capture.py pack --recording recording --output capture.zip
  python3 compress-capture.py pack --recording recording --output capture.zip \
      --chunks-dir transfer --chunk-bytes 120000
  python3 compress-capture.py unpack --archive capture.zip --recording restored
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import shlex
import zlib
import zipfile

from PIL import Image


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def read_frames(data: bytes) -> list[dict]:
    frames = [json.loads(line) for line in data.splitlines() if line.strip()]
    if not frames:
        raise ValueError('The capture has no frames.')
    previous = None
    for number, frame in enumerate(frames, 1):
        if frame.get('index') != number:
            raise ValueError('Frame indices must be consecutive and begin at one.')
        timestamp = float(frame['protocolTimestamp'])
        if not math.isfinite(timestamp) or previous is not None and timestamp <= previous:
            raise ValueError('Protocol timestamps must be finite and strictly increasing.')
        previous = timestamp
    return frames


def validate_manifest(manifest: dict, frames: list[dict]) -> None:
    if manifest.get('frameCount') != len(frames):
        raise ValueError('Manifest frameCount differs from the frame index.')
    span = float(frames[-1]['protocolTimestamp']) - float(frames[0]['protocolTimestamp'])
    if not math.isclose(float(manifest['recordedSpanSeconds']), span, abs_tol=0.00001, rel_tol=0):
        raise ValueError('Manifest duration differs from the genuine protocol timestamps.')


def xor_bytes(current: bytes, previous: bytes | None) -> bytes:
    if previous is None:
        return current
    if len(current) != len(previous):
        raise ValueError('Frame pixel dimensions changed during capture.')
    return (int.from_bytes(current, 'little') ^ int.from_bytes(previous, 'little')).to_bytes(len(current), 'little')


def write_chunks(archive: Path, directory: Path, chunk_bytes: int) -> None:
    if chunk_bytes < 4 or chunk_bytes % 4:
        raise ValueError('--chunk-bytes must be a positive multiple of four, at least four.')
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.glob('chunk-*.txt')) or (directory / 'transfer.json').exists():
        raise ValueError('Use a new chunks directory to avoid mixing separate captures.')
    chunks = []
    with archive.open('rb') as stream:
        while True:
            raw = stream.read(chunk_bytes // 4 * 3)
            if not raw:
                break
            data = base64.b64encode(raw)
            name = f'chunk-{len(chunks):06d}.txt'
            (directory / name).write_bytes(data)
            chunks.append({'file': name, 'base64Bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    metadata = {
        'schema': 1,
        'encoding': 'base64, concatenate listed chunks in order before decoding',
        'archive': archive.name,
        'archiveBytes': archive.stat().st_size,
        'archiveSha256': sha256(archive),
        'chunkBytesLimit': chunk_bytes,
        'chunks': chunks,
    }
    (directory / 'transfer.json').write_bytes(json_bytes(metadata))
    filename = shlex.quote(archive.name)
    digest = metadata['archiveSha256']
    instructions = (
        'Run inside this directory after transferring every chunk and transfer.json.\n\n'
        'POSIX shell:\n'
        f'cat chunk-*.txt | base64 --decode > {filename}\n'
        f"printf '%s  %s\\n' '{digest}' {filename} | sha256sum --check -\n\n"
        'Portable Python (also verifies every chunk and the reconstructed archive):\n'
        "python3 - <<'PY'\n"
        'import base64, hashlib, json\n'
        'from pathlib import Path\n'
        "m = json.loads(Path('transfer.json').read_text())\n"
        "output = Path(m['archive']).name\n"
        'digest = hashlib.sha256(); size = 0\n'
        "with Path(output).open('wb') as stream:\n"
        "    for chunk in m['chunks']:\n"
        "        data = Path(chunk['file']).read_bytes()\n"
        "        assert len(data) == chunk['base64Bytes']\n"
        "        assert hashlib.sha256(data).hexdigest() == chunk['sha256']\n"
        '        raw = base64.b64decode(data, validate=True)\n'
        '        stream.write(raw); digest.update(raw); size += len(raw)\n'
        "assert size == m['archiveBytes']\n"
        "assert digest.hexdigest() == m['archiveSha256']\n"
        "print(output, size, digest.hexdigest())\n"
        'PY\n\n'
        'Then restore with the supplied script:\n'
        f'python3 compress-capture.py unpack --archive {filename} --recording restored\n'
    )
    (directory / 'REASSEMBLE.txt').write_text(instructions)
    print(json.dumps({'chunksDirectory': str(directory), 'chunks': len(chunks), 'archiveBytes': metadata['archiveBytes'], 'archiveSha256': digest}))


def pack(args: argparse.Namespace) -> None:
    recording = args.recording.resolve()
    output = args.output.resolve()
    if output.exists():
        raise ValueError(f'Output already exists: {output}')
    if args.chunks_dir and (args.chunk_bytes < 4 or args.chunk_bytes % 4):
        raise ValueError('--chunk-bytes must be a positive multiple of four, at least four.')
    manifest_data = (recording / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_data)
    frames_name = manifest.get('framesIndex', 'frames.ndjson')
    if frames_name != 'frames.ndjson':
        raise ValueError('This transport expects frames.ndjson as the frame index.')
    index_data = (recording / frames_name).read_bytes()
    frames = read_frames(index_data)
    validate_manifest(manifest, frames)
    events_data = (recording / 'events.ndjson').read_bytes()
    output.parent.mkdir(parents=True, exist_ok=True)
    previous = None
    dimensions = None
    pixel_hashes = []
    try:
        with zipfile.ZipFile(output, 'x') as archive:
            for name, data in [('manifest.json', manifest_data), ('frames.ndjson', index_data), ('events.ndjson', events_data)]:
                archive.writestr('recording/' + name, data, compress_type=zipfile.ZIP_DEFLATED)
            concat = recording / manifest.get('encodingInput', 'frames.ffconcat')
            if concat.is_file():
                archive.writestr('recording/source-frames.ffconcat', concat.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
            for number, frame in enumerate(frames, 1):
                source = (recording / frame['file']).resolve()
                if not source.is_relative_to(recording):
                    raise ValueError('A source frame path escapes the recording directory.')
                with Image.open(source) as image:
                    rgb = image.convert('RGB')
                    if dimensions is None:
                        dimensions = rgb.size
                    if rgb.size != dimensions:
                        raise ValueError('Frame pixel dimensions changed during capture.')
                    pixels = rgb.tobytes()
                pixel_hashes.append(hashlib.sha256(pixels).hexdigest())
                delta = xor_bytes(pixels, previous)
                archive.writestr(f'delta/{number:06d}.rgb.zlib', zlib.compress(delta, level=9), compress_type=zipfile.ZIP_STORED)
                previous = pixels
            metadata = {
                'schema': 1,
                'mode': 'RGB', 'width': dimensions[0], 'height': dimensions[1],
                'frameCount': len(frames),
                'encoding': 'firstRGB; following bitwise XOR with previous RGB; independently zlib compressed',
                'source': 'Captured frames decoded by Pillow without resize or editing; original JPEG bytes are not retained',
                'decodedRgbSha256': pixel_hashes,
            }
            archive.writestr('delta/format.json', json_bytes(metadata), compress_type=zipfile.ZIP_DEFLATED)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    result = {'archive': str(output), 'bytes': output.stat().st_size, 'sha256': sha256(output), 'frameCount': len(frames)}
    print(json.dumps(result))
    if args.chunks_dir:
        write_chunks(output, args.chunks_dir.resolve(), args.chunk_bytes)


def unpack(args: argparse.Namespace) -> None:
    recording = args.recording.resolve()
    if recording.exists() and any(recording.iterdir()):
        raise ValueError('Restore into a new or empty recording directory.')
    with zipfile.ZipFile(args.archive) as archive:
        metadata = json.loads(archive.read('delta/format.json'))
        if metadata.get('mode') != 'RGB':
            raise ValueError('Only the RGB differential transport is supported.')
        width, height = int(metadata['width']), int(metadata['height'])
        if width <= 0 or height <= 0:
            raise ValueError('Invalid pixel dimensions.')
        manifest = json.loads(archive.read('recording/manifest.json'))
        original_index = archive.read('recording/frames.ndjson')
        frames = read_frames(original_index)
        validate_manifest(manifest, frames)
        if metadata.get('frameCount', len(frames)) != len(frames):
            raise ValueError('Transport frameCount differs from the original index.')
        hashes = metadata.get('decodedRgbSha256')
        if hashes is not None and len(hashes) != len(frames):
            raise ValueError('Transport pixel hash count differs from the original index.')
        (recording / 'frames').mkdir(parents=True, exist_ok=True)
        (recording / 'source-manifest.json').write_bytes(archive.read('recording/manifest.json'))
        (recording / 'source-frames.ndjson').write_bytes(original_index)
        (recording / 'events.ndjson').write_bytes(archive.read('recording/events.ndjson'))
        previous = None
        restored = []
        concat = ['ffconcat version 1.0']
        for number, frame in enumerate(frames, 1):
            delta = zlib.decompress(archive.read(f'delta/{number:06d}.rgb.zlib'))
            if len(delta) != width * height * 3:
                raise ValueError(f'Invalid decoded byte count for frame {number}.')
            pixels = xor_bytes(delta, previous)
            if hashes is not None and hashlib.sha256(pixels).hexdigest() != hashes[number - 1]:
                raise ValueError(f'Decoded pixel checksum failed for frame {number}.')
            previous = pixels
            name = f'frames/{number:06d}.png'
            target = recording / name
            Image.frombytes('RGB', (width, height), pixels).save(target)
            restored.append({**frame, 'sourceFile': frame['file'], 'sourceBytes': frame.get('bytes'), 'file': name, 'bytes': target.stat().st_size})
            concat.append(f"file '{name}'")
            if number < len(frames):
                concat.append('duration %.9f' % (float(frames[number]['protocolTimestamp']) - float(frame['protocolTimestamp'])))
        manifest['sourceFrameBytes'] = manifest.get('frameBytes')
        manifest['frameBytes'] = sum(frame['bytes'] for frame in restored)
        manifest['framesIndex'] = 'frames.ndjson'
        manifest['encodingInput'] = 'frames.ffconcat'
        manifest['restoration'] = {'encoding': 'PNG of exact decoded RGB', 'archiveSha256': sha256(args.archive), 'originalManifest': 'source-manifest.json', 'originalFramesIndex': 'source-frames.ndjson'}
        (recording / 'manifest.json').write_bytes(json_bytes(manifest))
        (recording / 'frames.ndjson').write_text(''.join(json.dumps(frame, ensure_ascii=False) + '\n' for frame in restored))
        (recording / 'frames.ffconcat').write_text('\n'.join(concat) + '\n')
    print(json.dumps({'recording': str(recording), 'frameCount': len(restored), 'recordedSpanSeconds': manifest['recordedSpanSeconds'], 'pixelsVerified': hashes is not None}))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    pack_parser = commands.add_parser('pack', help='Decode actual frames and create differential transport.')
    pack_parser.add_argument('--recording', type=Path, required=True)
    pack_parser.add_argument('--output', type=Path, required=True)
    pack_parser.add_argument('--chunks-dir', type=Path)
    pack_parser.add_argument('--chunk-bytes', type=int, default=120000, help='Maximum base64 characters per chunk; multiple of four.')
    pack_parser.set_defaults(func=pack)
    unpack_parser = commands.add_parser('unpack', help='Restore exact decoded RGB pixels, index, events, and genuine timing.')
    unpack_parser.add_argument('--archive', type=Path, required=True)
    unpack_parser.add_argument('--recording', type=Path, required=True)
    unpack_parser.set_defaults(func=unpack)
    args = parser.parse_args()
    try:
        args.func(args)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, zlib.error) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
