export type ImageGenerationModel =
  | 'gpt-image-2.6-flare'
  | 'gpt-image-2.6-sunburst'
  | 'gpt-image-2.5-flare'
  | 'gpt-image-2.5-sunburst'
  | 'gpt-image-2'

export type ImageOutputFormat = 'png' | 'gif'
export type ImageComplexity = 'low' | 'medium' | 'high'

export const IMAGE_GENERATION_DEFAULT_MODEL: ImageGenerationModel = 'gpt-image-2.6-flare'
export const IMAGE_GENERATION_MODELS: Array<{ value: ImageGenerationModel; label: string }> = [
  { value: 'gpt-image-2.6-flare', label: 'Image 2.6F' },
  { value: 'gpt-image-2.6-sunburst', label: 'Image 2.6S' },
  { value: 'gpt-image-2.5-flare', label: 'Image 2.5F' },
  { value: 'gpt-image-2.5-sunburst', label: 'Image 2.5S' },
  { value: 'gpt-image-2', label: 'Image 2' },
]

export interface ImageGenerationOptions {
  model: ImageGenerationModel
  mode: 'text' | 'image'
  size: string
  quality: string
  imageCount: number
  referenceImagePaths: string[]
  outputFormat: ImageOutputFormat
  complexity: ImageComplexity
  frameCount: number
  frameDurationMs: number
}

export type ImageGenerationParameters = Omit<ImageGenerationOptions, 'complexity' | 'frameCount' | 'frameDurationMs'> & {
  complexity?: ImageComplexity
  frameCount?: number
  frameDurationMs?: number
}

export function supportsImage26Options(model: string): boolean {
  return model === 'gpt-image-2.6-flare' || model === 'gpt-image-2.6-sunburst'
}

export function resolveImageGenerationModel(savedModel: string | null): ImageGenerationModel {
  return IMAGE_GENERATION_MODELS.find((option) => option.value === savedModel)?.value ?? IMAGE_GENERATION_DEFAULT_MODEL
}

// Called when the model or output format changes. GIF-only values never leak back
// into static image editing, and old model selections keep their own capabilities.
export function normalizeImageGenerationSelection(
  options: ImageGenerationOptions,
  previousOutputFormat: ImageOutputFormat,
): ImageGenerationOptions {
  const supports26 = supportsImage26Options(options.model)
  const outputFormat = supports26 ? options.outputFormat : 'png'
  const isGif = outputFormat === 'gif'
  const leavingGif = previousOutputFormat === 'gif' && !isGif
  return {
    ...options,
    outputFormat,
    mode: isGif || leavingGif ? 'text' : options.mode,
    size: isGif ? 'auto' : leavingGif ? '1024x1024' : options.size,
    imageCount: isGif || leavingGif ? 1 : options.imageCount,
    referenceImagePaths: isGif || leavingGif ? [] : options.referenceImagePaths,
    complexity: supports26 ? options.complexity : 'high',
    frameCount: isGif ? options.frameCount : 9,
    frameDurationMs: isGif ? options.frameDurationMs : 200,
  }
}

export function buildImageGenerationParameters(options: ImageGenerationOptions): ImageGenerationParameters {
  const supports26 = supportsImage26Options(options.model)
  const isGif = options.outputFormat === 'gif'
  if (isGif && !supports26) throw new Error('GIF 动图需要选择 Image 2.6F 或 Image 2.6S。')
  if (isGif && (!Number.isInteger(options.frameCount) || options.frameCount < 2 || options.frameCount > 16)) {
    throw new Error('动图帧数需要填写 2–16 之间的整数。')
  }
  if (isGif && (!Number.isInteger(options.frameDurationMs) || options.frameDurationMs < 20 || options.frameDurationMs > 2000 || options.frameDurationMs % 10 !== 0)) {
    throw new Error('每帧时长需要填写 20–2000 毫秒，且为 10 的倍数。')
  }
  return {
    model: options.model,
    mode: isGif ? 'text' : options.mode,
    size: isGif ? 'auto' : options.size,
    quality: options.quality,
    imageCount: isGif ? 1 : options.imageCount,
    referenceImagePaths: !isGif && options.mode === 'image' ? [...options.referenceImagePaths] : [],
    outputFormat: options.outputFormat,
    ...(supports26 ? { complexity: options.complexity } : {}),
    ...(isGif ? { frameCount: options.frameCount, frameDurationMs: options.frameDurationMs } : {}),
  }
}
