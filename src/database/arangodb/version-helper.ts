import { Database } from 'arangojs';

export interface ArangoDBVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}

export class ArangoDBVersionHelper {
    constructor(private readonly db: Database) {}

    async getArangoDBVersionAsString(): Promise<string | undefined> {
        const versionInfo = await this.db.version();
        return versionInfo.version;
    }

    async getArangoDBVersion(): Promise<ArangoDBVersion | undefined> {
        const version = await this.getArangoDBVersionAsString();
        if (!version) {
            return undefined;
        }
        return this.parseVersion(version);
    }

    parseVersion(version: string): ArangoDBVersion | undefined {
        const parts = version.split('.');
        if (parts.length < 3) {
            return undefined;
        }
        const numParts = parts.slice(0, 3).map((p) => parseInt(p, 10));
        if (numParts.some((p) => !isFinite(p))) {
            return undefined;
        }
        const [major, minor, patch] = numParts;
        return { major, minor, patch };
    }
}
