/// <reference types="node" />
export declare function crc32(bytes: Uint8Array): number;
export declare function encodePng(width: number, height: number, rgba: Uint8Array): Buffer;
export declare function drawIcon(size: number, colors?: { plum: string; cream: string; gold: string }): Uint8Array;
export declare function iconPng(size: number, colors?: { plum: string; cream: string; gold: string }): Buffer;
