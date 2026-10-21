import type { LearnerEditorKey } from '@reachany/learner-editor';

export const learnerEditorFallback: Record<LearnerEditorKey, string> = {
  imageLimit: 'Selected images exceed the remaining attachment limit.',
  toolbar: 'Answer formatting',
  bold: 'Bold',
  italic: 'Italic',
  bulletList: 'Bullet list',
  orderedList: 'Numbered list',
  heading: 'Heading',
  blockquote: 'Quote',
  codeBlock: 'Code block',
  undo: 'Undo',
  redo: 'Redo',
  inlineMath: 'Inline formula',
  blockMath: 'Block formula',
  uploadImage: 'Upload image',
  takePhoto: 'Take photo',
  systemCamera: 'Take photo or choose image',
  cameraTitle: 'Take a photo',
  cameraPreview: 'Live camera preview',
  photoPreview: 'Captured photo',
  capture: 'Capture',
  retake: 'Retake',
  usePhoto: 'Use photo',
  close: 'Close',
  cameraStarting: 'Starting camera…',
  cameraInsecure:
    'The camera requires HTTPS or a local connection. You can upload a photo instead.',
  cameraUnavailable:
    'This browser cannot open the camera. Try taking a photo or choosing an image below.',
  cameraDenied:
    'Camera access was denied. Allow camera access in browser settings or upload an image.',
  cameraNotFound: 'No camera was found. Connect a camera or upload an image.',
  cameraError:
    'The camera could not be opened. Check whether another app is using it, or upload an image.',
  imageError: 'This image cannot be read. Use JPEG, PNG or WebP, up to 100 MiB per file.',
  uploadError: 'Image upload failed. Please try again.',
  uploading: 'Uploading image…',
};
