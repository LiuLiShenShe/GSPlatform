/**
 * Typed error classification for the viewer adapter.
 * The web page maps these to user-facing messages; the code keeps developer
 * diagnostic detail separately so nothing secret leaks to the UI.
 */
export type ViewerErrorCode =
    | 'SCENE_NOT_FOUND'
    | 'ASSET_FETCH_FAILED'
    | 'ASSET_INVALID'
    | 'GRAPHICS_UNSUPPORTED'
    | 'VIEWER_INIT_FAILED'
    | 'CONTEXT_LOST'
    | 'UNKNOWN';

export interface ViewerErrorDetail {
    code: ViewerErrorCode;
    /** Developer-facing diagnostic context (never shown to users as-is). */
    message: string;
}

export class ViewerError extends Error {
    readonly code: ViewerErrorCode;
    readonly detail: string;

    constructor(code: ViewerErrorCode, detail: string) {
        super(code);
        this.name = 'ViewerError';
        this.code = code;
        this.detail = detail;
    }

    toJSON(): ViewerErrorDetail {
        return {
            code: this.code,
            message: this.detail
        };
    }
}

/** Add a stable message for the user-visible layer. */
export const codeToUserMessage = (code: ViewerErrorCode): string => {
    switch (code) {
        case 'SCENE_NOT_FOUND':
            return '找不到该场景或场景资产缺失。';
        case 'ASSET_FETCH_FAILED':
            return '场景资产加载失败，可能是网络或服务问题。';
        case 'ASSET_INVALID':
            return '场景文件损坏或不是有效的高斯场景。';
        case 'GRAPHICS_UNSUPPORTED':
            return '当前浏览器不支持所需的图形能力（WebGPU / WebGL2）。';
        case 'VIEWER_INIT_FAILED':
            return '3D 查看器初始化失败，请刷新页面重试。';
        case 'CONTEXT_LOST':
            return '图形上下文已丢失，请刷新页面。';
        default:
            return '查看器发生未知错误。';
    }
};
