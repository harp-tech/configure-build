import * as fs from 'fs';
import { parse } from 'yaml'
import * as semver from 'semver';

export function getFirmwareVersion(path: string): semver.SemVer | null {
    const contents = fs.readFileSync(path, 'utf8')
    const deviceMetadata = parse(contents)
    return semver.coerce(deviceMetadata.firmwareVersion)
}
