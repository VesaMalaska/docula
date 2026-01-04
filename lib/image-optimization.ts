/**
 * Optimizes an image file for upload.
 * 1. Resizes the image if its width exceeds 1024px, maintaining aspect ratio.
 * 2. Converts the image to WebP format.
 */
export async function optimizeImage(file: File): Promise<File> {
  // Initial check based on MIME type
  if (!file.type.startsWith('image/')) {
    throw new Error('NOT_AN_IMAGE');
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // ... (rest of the resizing logic)
        const maxWidth = 1024;
        let width = img.width;
        let height = img.height;

        // Calculate new dimensions if resizing is needed
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }

        // Create canvas for resizing and format conversion
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Draw image onto canvas
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to WebP
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error('Failed to create blob from canvas'));
              return;
            }

            // Create a new File object from the blob
            // Change extension to .webp
            const newName = file.name.replace(/\.[^/.]+$/, "") + ".webp";
            const optimizedFile = new File([blob], newName, {
              type: 'image/webp',
              lastModified: Date.now(),
            });

            resolve(optimizedFile);
          },
          'image/webp',
          0.85 // Quality setting (0 to 1)
        );
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = event.target?.result as string;
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}
