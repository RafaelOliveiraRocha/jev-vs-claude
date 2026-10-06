#!/usr/bin/env python3
"""Encode a continuous genuine capture at explicit 1.5x, with factual captions.

No browser, network, model, or synthetic-progress calls are made. Pre-click
waiting and the long static final hold are trimmed. Processing and inspection
remain continuous. All retained actual intervals receive the same 1.5x playback speed.
The captured UI clocks and ledger metrics keep their actual elapsed times.

  python render-recording.py
  python render-recording.py --plan-only
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
from pathlib import Path
import re
import subprocess

from PIL import Image, ImageFont

ROOT = Path(__file__).resolve().parent
FONT = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
WIDTH, VIEWPORT_HEIGHT, HEIGHT = 1366, 768, 900
FPS = 30


def utc_seconds(value: str) -> float:
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def ass_time(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remaining = divmod(centiseconds, 360000)
    minutes, remaining = divmod(remaining, 6000)
    seconds, centiseconds = divmod(remaining, 100)
    return f'{hours}:{minutes:02}:{seconds:02}.{centiseconds:02}'


def ass_escape(text: str) -> str:
    return text.replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}').replace('\n', '\\N')


def filter_escape(path: Path) -> str:
    # Filter arguments, never shell arguments. subprocess is always called with a list.
    return str(path).replace('\\', '\\\\').replace(':', '\\:').replace("'", "\\'")


def wrap_caption(text: str, size: int = 31) -> tuple[str, int]:
    for font_size in range(size, 27, -1):
        font = ImageFont.truetype(str(FONT), font_size)
        lines: list[str] = []
        for paragraph in text.split('\n'):
            line = ''
            for word in paragraph.split():
                trial = f'{line} {word}'.strip()
                if line and font.getlength(trial) > 1250:
                    lines.append(line)
                    line = word
                else:
                    line = trial
            lines.append(line)
        if len(lines) <= 2:
            return '\n'.join(lines), font_size
    raise ValueError(f'Caption needs more than two lines: {text}')


def read_concat(path: Path) -> tuple[list[float], list[Path]]:
    durations: list[float] = []
    files: list[Path] = []
    for line in path.read_text().splitlines():
        if line.startswith('duration '):
            value = float(line.split(maxsplit=1)[1])
            if not math.isfinite(value) or value <= 0:
                raise ValueError(f'Invalid real frame interval: {line}')
            durations.append(value)
        elif line.startswith('file '):
            match = re.fullmatch(r"file '(.*)'", line)
            if not match:
                raise ValueError(f'Unsupported concat filename: {line}')
            files.append((path.parent / match.group(1)).resolve())
    if len(files) < 2 or len(durations) != len(files) - 1:
        raise ValueError('Expected one genuine duration between each pair of captured frames.')
    return durations, files


def clip_actual_intervals(files: list[Path], durations: list[float], start: float, end: float, output: Path) -> None:
    """Keep the real frame active at each cut, including long static intervals.

    A frame-level trim filter would discard a frame that starts before the edit
    boundary even when its captured interval covers that boundary. Clipping the
    concat intervals retains that same captured image until the next actual
    captured frame arrives. No interior interval or processing frame is changed.
    """
    lines = ['ffconcat version 1.0']
    time = 0.0
    last_file = None
    retained_duration = 0.0
    for path, interval in zip(files, durations):
        next_time = time + interval
        left, right = max(time, start), min(next_time, end)
        if right > left:
            if "'" in str(path):
                raise ValueError('A capture filename contains an unsupported apostrophe.')
            lines += [f"file '{path}'", f'duration {right-left:.9f}']
            retained_duration += right - left
            last_file = path
        time = next_time
    if last_file is None or abs(retained_duration - (end-start)) > 0.00001:
        raise ValueError('Unable to clip the actual captured intervals at the edit boundaries.')
    # Endpoint sentinel makes the final actual retained interval explicit to the
    # concat demuxer. -t excludes the sentinel itself from the encoded output.
    lines.append(f"file '{last_file}'")
    output.write_text('\n'.join(lines) + '\n')


def completed_observation(manifest: dict, provider: str, after: float) -> float:
    first = float(manifest['firstProtocolTimestamp'])
    for event in manifest.get('events', []):
        state = event.get('state') or {}
        for lane in state.get('providers', []):
            if lane.get('provider') != provider:
                continue
            try:
                completed = int(lane['count']) == int(lane['total']) and int(lane['total']) > 0
            except (KeyError, ValueError, TypeError):
                completed = False
            time = utc_seconds(event['at']) - first
            if completed and time > after:
                return time
    raise ValueError(f'No genuine UI observation of {provider} completing its batch.')


def action_time(manifest: dict, predicate) -> float | None:
    first = float(manifest['firstProtocolTimestamp'])
    for action in manifest.get('actions', []):
        if predicate(action):
            return utc_seconds(action['at']) - first
    return None


def finite_metric(metrics: dict, key: str, *, positive: bool = False) -> float:
    value = float(metrics[key])
    if not math.isfinite(value) or value < 0 or (positive and value <= 0):
        raise ValueError(f'Invalid measured metric {key}: {value}')
    return value


def portuguese(value: float, digits: int = 2) -> str:
    return f'{value:.{digits}f}'.replace('.', ',')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recording', type=Path, default=ROOT / 'recording')
    parser.add_argument('--results', type=Path, default=ROOT / 'results.json')
    parser.add_argument('--dataset', type=Path, default=ROOT / 'dataset.json')
    parser.add_argument('--questions', type=Path, default=ROOT / 'questions.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'jev-vs-claude-50.mp4')
    parser.add_argument('--lead-in', type=float, default=2.0, help='Only pre-click idle is trimmed; actual seconds retained before click.')
    parser.add_argument('--target-seconds', type=float, default=60.0, help='Approximate output duration, never attained by cutting processing.')
    parser.add_argument('--tail-hold', type=float, default=25.0, help='Maximum actual seconds retained after closing the reference.')
    parser.add_argument('--batch-start', type=float, help='Override actual batch click offset from first captured frame.')
    parser.add_argument('--refs-open', type=float, help='Override actual reference click offset from first captured frame.')
    parser.add_argument('--plan-only', action='store_true')
    args = parser.parse_args()
    speed = 1.5
    if not 0 < args.lead_in <= 5 or not 15 <= args.tail_hold <= 60 or not 20 <= args.target_seconds <= 180:
        raise ValueError('Use lead-in >0 and <=5, tail-hold >=15 and <=60, and target-seconds >=20 and <=180.')
    recording, output = args.recording.resolve(), args.output.resolve()
    manifest = json.loads((recording / 'manifest.json').read_text())
    if not manifest.get('continuous') or manifest.get('syntheticProgress') is not False:
        raise ValueError('Only a continuous, genuine CDP recording is accepted.')
    if manifest.get('error') or not manifest.get('batchCompleted'):
        raise ValueError('The capture must contain a genuinely completed batch.')
    if manifest.get('viewport') != {'width': WIDTH, 'height': VIEWPORT_HEIGHT}:
        raise ValueError('The recording must have its native 1366×768 viewport.')

    durations, files = read_concat(recording / manifest.get('encodingInput', 'frames.ffconcat'))
    source_duration = sum(durations)
    if abs(source_duration - float(manifest['recordedSpanSeconds'])) > 0.003:
        raise ValueError('Concat intervals differ from the genuine CDP span.')
    if len(files) != manifest['frameCount'] or any(not file.is_file() for file in files):
        raise ValueError('Missing captured frames, or frame count differs from the manifest.')
    for file in files:
        with Image.open(file) as image:
            image.load()
            if image.size != (WIDTH, VIEWPORT_HEIGHT):
                raise ValueError(f'Captured frame has incorrect native geometry: {file}')

    dataset = json.loads(args.dataset.read_text())
    questions = json.loads(args.questions.read_text())
    cases = [case for case in dataset['cases'] if case.get('split') in (None, 'benchmark')]
    class_questions = [question for question in questions['questions'] if question['type'] == 'classification']
    evidence_questions = [question for question in questions['questions'] if question['type'] == 'evidence']
    case_count, class_count, evidence_count = len(cases), len(class_questions), len(evidence_questions)
    expected_categories, expected_evidence = case_count * class_count, case_count * evidence_count
    if not case_count or not class_count or class_count != evidence_count or dataset.get('fictional') is not True:
        raise ValueError('A declared synthetic dataset with paired classification/evidence questions is required.')
    results = json.loads(args.results.read_text())
    runs = [run for run in results.get('runs', []) if run.get('phase') == 'benchmark' and run.get('status') == 'completed']
    if not runs:
        raise ValueError('No completed benchmark ledger is available to substantiate captions.')
    run = runs[-1]
    recorded_run_id = (manifest.get('finalState') or {}).get('benchmarkRunId')
    if recorded_run_id and recorded_run_id != run['runId']:
        raise ValueError('The result ledger belongs to a different recorded run.')
    if set(run['caseIds']) != {case['id'] for case in cases} or len(run['caseIds']) != case_count:
        raise ValueError('The result ledger does not cover exactly the selected dataset.')
    import hashlib
    for key, file in [('datasetSha256', args.dataset), ('questionsSha256', args.questions)]:
        if run.get(key) and run[key] != hashlib.sha256(file.read_bytes()).hexdigest():
            raise ValueError(f'Ledger input fingerprint differs: {key}')
    metrics = run['providers']
    names = {'jev': 'Jev', 'claude': 'Claude'}
    for provider in names:
        m = metrics[provider]
        finite_metric(m, 'batchElapsedMs', positive=True)
        if int(m['completed']) != case_count or int(m['total']) != case_count:
            raise ValueError(f'{provider} has not received all {case_count} responses.')
        for correct_key, total_key, expected in [('categoryCorrect', 'categoryTotal', expected_categories), ('evidenceCorrect', 'evidenceTotal', expected_evidence)]:
            correct, total = finite_metric(m, correct_key), finite_metric(m, total_key)
            if not correct.is_integer() or not total.is_integer() or not 0 <= correct <= total <= expected:
                raise ValueError(f'Invalid observed score: {provider}.{correct_key}/{total_key}')
        finite_metric(m, 'validationFailures')
        if m.get('estimatedCostUsd') is not None:
            finite_metric(m, 'estimatedCostUsd')

    batch_click = args.batch_start
    if batch_click is None:
        batch_click = action_time(manifest, lambda a: a.get('action') == 'click' and a.get('selector') == '#run')
    if batch_click is None or not 0 <= batch_click < source_duration:
        raise ValueError('Cannot identify the actual Processar lote click within this capture.')
    first = float(manifest['firstProtocolTimestamp'])
    if abs(utc_seconds(run['createdAt']) - first - batch_click) > 1.5:
        raise ValueError('The result ledger start does not match the recorded batch click.')
    done_source = {p: completed_observation(manifest, p, batch_click) for p in names}
    processing_end = max(done_source.values())
    ledger_end = utc_seconds(run['completedAt']) - first
    processing_end = max(processing_end, ledger_end)
    refs_open = args.refs_open
    if refs_open is None:
        refs_open = action_time(manifest, lambda a: a.get('selector') == '[data-ref-provider]')
    refs_close = action_time(manifest, lambda a: a.get('selector') == '#modal-close')
    if refs_open is None or refs_close is None:
        raise ValueError('The actual recording must open and close a classification reference.')
    if not batch_click < min(done_source.values()) <= processing_end <= refs_open < refs_close < source_duration:
        raise ValueError('Actual processing/inspection events do not occur in the required order.')

    trim_start = max(0.0, batch_click - args.lead_in)
    minimum_end = refs_close + 15.0  # Ten output seconds for three readable factual caption panels.
    if source_duration + 0.03 < minimum_end:
        raise ValueError('Capture needs at least 15 actual seconds after closing the reference; record with --post-seconds 32.')
    preferred_end = min(trim_start + args.target_seconds * speed, refs_close + args.tail_hold)
    retained_end = min(source_duration, max(minimum_end, preferred_end))
    retained_real_duration = retained_end - trim_start
    duration = retained_real_duration / speed
    if trim_start > batch_click or retained_end < processing_end:
        raise ValueError('An edit would remove part of the actual processing interval.')
    trimmed_concat = recording / 'retained-actual-frames.ffconcat'
    clip_actual_intervals(files, durations, trim_start, retained_end, trimmed_concat)
    done = {p: (time - trim_start) / speed for p, time in done_source.items()}
    open_time, close_time = (refs_open - trim_start) / speed, (refs_close - trim_start) / speed
    first_provider, last_provider = sorted(names, key=lambda provider: (done[provider], provider))
    first_done, last_done = done[first_provider], max(done.values())
    j, c = metrics['jev'], metrics['claude']
    time_text = f"Tempo real do lote: Jev {portuguese(j['batchElapsedMs']/1000)} s | Claude {portuguese(c['batchElapsedMs']/1000)} s."
    costs = ' | '.join(f"{names[p]} US$ {portuguese(metrics[p]['estimatedCostUsd'], 5)}" if metrics[p].get('estimatedCostUsd') is not None else f'{names[p]} não estimável' for p in names)
    category_text = ' | '.join(f"{names[p]} {int(metrics[p]['categoryCorrect'])}/{int(metrics[p]['categoryTotal'])}" for p in names)
    evidence_text = ' | '.join(f"{names[p]} {int(metrics[p]['evidenceCorrect'])}/{int(metrics[p]['evidenceTotal'])}" for p in names)
    failures_text = ' | '.join(f"{names[p]} {int(metrics[p]['validationFailures'])}" for p in names)
    captions = []
    def add(start: float, end: float, text: str) -> None:
        if end - start > 0.03:
            captions.append((start, end, text))
    intro_end = 4.0 if first_done > 4.0 else first_done / 2.0
    add(0.0, intro_end, f'{case_count} atendimentos sintéticos. Mesmas entradas para os dois modelos.\n{class_count} perguntas de classificação + {evidence_count} evidências por atendimento.')
    add(intro_end, first_done, 'Chamadas reais às APIs. Concorrência igual: 2 pedidos por modelo.\nTodo o processamento aparece sem cortes, em reprodução 1,5×.')
    completed_note_end = min(last_done, max(16.0, first_done + 3.0))
    add(first_done, completed_note_end, f"{names[first_provider]} concluiu seus {case_count} atendimentos; {names[last_provider]} continua.\nTempo real medido de {names[first_provider]}: {portuguese(metrics[first_provider]['batchElapsedMs']/1000)} s.")
    fields_end = min(last_done, max(26.0, completed_note_end + 3.0))
    add(completed_note_end, fields_end, 'Necessidade, dificuldade, resolução, motivo da transferência.\nAvaliações positiva e negativa: seis classificações estruturadas.')
    criteria_end = min(last_done, max(36.0, fields_end + 3.0))
    add(fields_end, criteria_end, 'Os modelos recebem os mesmos diálogos, perguntas e critérios.\nGabarito local definido antes do lote; não enviado às APIs.')
    add(criteria_end, last_done, f'{names[last_provider]} continua: classificações e evidências seguem independentes.\nResolução exige relato explícito do cliente; promessa não basta.')
    add(last_done, open_time, time_text + '\nCusto estimado: ' + costs + '.')
    add(open_time, close_time, 'Quando há evidência suficiente, a resposta aponta para uma mensagem.\nA referência exibida permite conferir o julgamento.')
    category_end = min(close_time + 4.0, duration - 6.0)
    evidence_end = min(category_end + 4.0, duration - 2.0)
    add(close_time, category_end, f'Acordo nas classificações válidas: {category_text}.\n{expected_categories} julgamentos previstos por modelo; gabarito definido antes do lote.')
    add(category_end, evidence_end, f'Acordo nas evidências válidas: {evidence_text}.\nFalhas de validação: {failures_text}.')
    add(evidence_end, duration, 'Atendimentos sintéticos revisados. Uma execução controlada.\nTempos, custos e acertos deste lote; sem generalização de desempenho.')

    ass = recording / 'captions.ass'
    lines = [
        '[Script Info]', 'ScriptType: v4.00+', f'PlayResX: {WIDTH}', f'PlayResY: {HEIGHT}', 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Main,DejaVu Sans,31,&H00F3F5F8,&H00F3F5F8,&H0015210B,&H0015210B,0,0,0,0,100,100,0,0,1,0,0,5,40,40,0,1',
        'Style: Footer,DejaVu Sans,19,&H007AD9F2,&H007AD9F2,&H0015210B,&H0015210B,-1,0,0,0,100,100,0,0,1,0,0,5,40,40,0,1', '',
        '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ]
    caption_report = []
    for start, end, text in captions:
        wrapped, font_size = wrap_caption(text)
        lines.append(f'Dialogue: 1,{ass_time(start)},{ass_time(end)},Main,,0,0,0,,{{\\pos(683,814)\\fs{font_size}}}{ass_escape(wrapped)}')
        caption_report.append({'startSeconds': start, 'endSeconds': end, 'text': text, 'fontSize': font_size})
    footer = 'REPRODUÇÃO 1,5× • relógios mostram tempos reais • atendimentos sintéticos'
    lines.append(f'Dialogue: 0,0:00:00.00,{ass_time(duration)},Footer,,0,0,0,,{{\\pos(683,878)}}{ass_escape(footer)}')
    ass.write_text('\n'.join(lines) + '\n')
    time_ratio = c['batchElapsedMs'] / j['batchElapsedMs']
    cost_ratio = c['estimatedCostUsd'] / j['estimatedCostUsd'] if c.get('estimatedCostUsd') is not None and j.get('estimatedCostUsd') else None
    report = {
        'source': manifest['source'], 'sourceFrameCount': len(files), 'allSourceFramesDecoded': True,
        'sourceDurationSeconds': source_duration, 'sourceFirstProtocolTimestamp': first,
        'batchClickSourceSeconds': batch_click, 'processingEndSourceSeconds': processing_end,
        'removedPreClickIdleSeconds': trim_start, 'retainedSourceEndSeconds': retained_end,
        'removedStaticFinalTailSeconds': source_duration - retained_end, 'interiorCuts': 0,
        'wholeProcessingIntervalPreserved': True, 'preservedLeadInSeconds': batch_click - trim_start,
        'playbackSpeed': speed, 'uiClocksAndReportedMetricsRetimed': False,
        'targetOutputDurationSeconds': args.target_seconds, 'expectedOutputDurationSeconds': duration,
        'nativeViewport': [WIDTH, VIEWPORT_HEIGHT], 'outputDimensions': [WIDTH, HEIGHT], 'captionsCoverViewport': False,
        'outputFps': FPS, 'realObservedEventOutputSeconds': {**{f'{p}Complete': done[p] for p in names}, 'referenceOpen': open_time, 'referenceClose': close_time},
        'benchmarkRunId': run['runId'], 'caseCount': case_count,
        'classificationQuestionsPerCase': class_count, 'evidenceQuestionsPerCase': evidence_count,
        'expectedCategoryJudgmentsPerProvider': expected_categories, 'expectedEvidenceJudgmentsPerProvider': expected_evidence,
        'metrics': metrics, 'timeRatioClaudeDividedByJev': time_ratio,
        'estimatedCostRatioClaudeDividedByJev': cost_ratio, 'captions': caption_report,
        'persistentCaption': footer, 'output': str(output),
    }
    report_path = recording / 'render-report.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'durationSeconds': duration, 'playbackSpeed': speed, 'wholeProcessingIntervalPreserved': True, 'events': report['realObservedEventOutputSeconds'], 'plan': str(report_path)}, ensure_ascii=False), flush=True)
    if args.plan_only:
        return
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.stem + '.encoding.mp4')
    filters = ','.join([
        f'trim=end={retained_real_duration:.9f}', f'setpts=(PTS-STARTPTS)/{speed}',
        f'fps={FPS}:start_time=0', f'pad={WIDTH}:{HEIGHT}:0:0:color=0x0b1521',
        f'drawbox=x=0:y={VIEWPORT_HEIGHT}:w=iw:h={HEIGHT-VIEWPORT_HEIGHT}:color=0x0b1521:t=fill',
        f'drawbox=x=0:y={VIEWPORT_HEIGHT}:w=iw:h=2:color=0x8b9fd0:t=fill',
        f"subtitles=filename='{filter_escape(ass)}':fontsdir='{FONT.parent}'",
    ])
    command = [
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'warning', '-xerror', '-f', 'concat', '-safe', '0', '-i', str(trimmed_concat),
        '-vf', filters, '-t', f'{duration:.9f}', '-an', '-c:v', 'libx264', '-threads', '2',
        '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temporary),
    ]
    subprocess.run(command, check=True)
    probe = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration,size:stream=width,height,codec_name,avg_frame_rate', '-of', 'json', str(temporary),
    ]))
    stream, encoded_duration = probe['streams'][0], float(probe['format']['duration'])
    if (stream['width'], stream['height']) != (WIDTH, HEIGHT) or stream['codec_name'] != 'h264':
        raise ValueError('The encoded file has unexpected geometry or codec.')
    if abs(encoded_duration - duration) > 2 / FPS + 0.01 or int(probe['format']['size']) < 10000:
        raise ValueError('The encoded duration differs from the complete timeline at 1.5x.')
    subprocess.run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(temporary), '-f', 'null', '-'], check=True)
    temporary.replace(output)
    report.update({'actualOutputDurationSeconds': encoded_duration, 'encodedBytes': int(probe['format']['size']), 'fullDecodePassed': True, 'probe': probe})
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'video': str(output), 'durationSeconds': encoded_duration, 'playbackSpeed': speed, 'fullDecodePassed': True, 'report': str(report_path)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
