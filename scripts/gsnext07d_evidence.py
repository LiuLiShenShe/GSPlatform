#!/usr/bin/env python3
"""CPU-only identity audits and image evidence for the GS-NEXT-07D TEST_ONLY run."""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

import numpy as np

TARGET_SOURCE_ROW = 11183581
TARGET_SAMPLE_ROW = 159


def sha256(file):
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def load_ply(data):
    stream = io.BytesIO(data)
    lines = []
    while True:
        line = stream.readline()
        assert line, 'truncated PLY header'
        lines.append(line.decode('ascii').strip())
        if lines[-1] == 'end_header':
            break
    assert 'format binary_little_endian 1.0' in lines
    count = int(next(s.split()[2] for s in lines if s.startswith('element vertex ')))
    properties = [s.split() for s in lines if s.startswith('property ')]
    assert all(s[1] == 'float' for s in properties)
    dtype = np.dtype([(s[2], '<f4') for s in properties])
    assert len(data) == stream.tell() + count * dtype.itemsize
    return np.frombuffer(data, dtype=dtype, count=count, offset=stream.tell())


def keys(array, fields):
    values = np.column_stack([array[field] for field in fields]).astype('<f4')
    return values.view(f'V{values.shape[1] * 4}').ravel()


def audit_project(args):
    sample = load_ply(Path(args.input).read_bytes())
    assert len(sample) == 106283 and len(sample.dtype.names) == 62
    with Path(args.mapping).open() as stream:
        mapping = list(csv.DictReader(stream))
    assert int(mapping[TARGET_SAMPLE_ROW]['source_row_0based']) == TARGET_SOURCE_ROW, mapping[TARGET_SAMPLE_ROW]
    with zipfile.ZipFile(args.project) as archive:
        document = json.loads(archive.read('document.json'))
        assert len(document['resources']) == len(document['splats']) == 1
        resource = load_ply(archive.read(document['resources'][0]['filename']))
        blob = archive.read(document['splats'][0]['instances'])
    assert set(resource.dtype.names) == set(sample.dtype.names)
    original_keys = keys(sample, sample.dtype.names)
    resource_keys = keys(resource, sample.dtype.names)
    assert len(np.unique(original_keys)) == len(sample)
    lookup = {value.tobytes(): i for i, value in enumerate(original_keys)}
    resource_to_sample = np.array([lookup[value.tobytes()] for value in resource_keys], dtype=np.int64)
    words = np.frombuffer(blob, dtype='<u4', count=5)
    # Official instances_*.bin: five uint32 header words, source indices,
    # packed uint32 palette indices, uint8 flags, then aligned palettes.
    count = int(words[2])
    assert count == args.expected_count, (words.tolist(), args.expected_count)
    source = np.frombuffer(blob, dtype='<u4', count=count, offset=20)
    flags = np.frombuffer(blob, dtype='u1', count=count, offset=20 + count * 8)
    sample_rows = resource_to_sample[source]
    assert len(np.unique(sample_rows)) == count
    selected = sample_rows[np.flatnonzero(flags & 1)].tolist()
    assert len(selected) == args.selected
    assert np.count_nonzero(flags & 2) == 0
    missing = np.setdiff1d(np.arange(len(sample)), sample_rows).tolist()
    if count == len(sample):
        assert missing == []
        if args.selected:
            assert selected == [TARGET_SAMPLE_ROW], selected
    else:
        assert missing == [TARGET_SAMPLE_ROW], missing
        assert selected == []
    return {
        'status': 'PASS', 'projectSha256': sha256(args.project), 'inputSha256': sha256(args.input),
        'sourceRowZeroBased': TARGET_SOURCE_ROW, 'sampleRowZeroBased': TARGET_SAMPLE_ROW,
        'resourceCount': len(resource), 'instanceCount': count,
        'selectedSampleRows': selected, 'missingSampleRows': missing,
        'targetResourceRows': np.flatnonzero(resource_to_sample == TARGET_SAMPLE_ROW).tolist(),
        'all62FieldsBitIdenticalForEveryRetainedGaussian': True,
        'documentCamera': document['camera'], 'documentView': document['view']
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    audit = commands.add_parser('audit-project')
    for name in ['input', 'mapping', 'project']:
        audit.add_argument(f'--{name}', required=True)
    audit.add_argument('--expected-count', type=int, required=True, choices=[106283, 106282])
    audit.add_argument('--selected', type=int, required=True, choices=[0, 1])
    args = parser.parse_args()
    print(json.dumps(audit_project(args), indent=2))


if __name__ == '__main__':
    main()
