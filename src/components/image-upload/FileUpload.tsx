'use client';

import { useCallback, useState } from 'react';
import { Upload, Image as ImageIcon, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const MAX_FILE_SIZE = 12 * 1024 * 1024; // 12MB
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

interface FileUploadProps {
  onFileSelect: (file: File, previewUrl: string) => void;
  onClear?: () => void;
  previewUrl?: string | null;
  disabled?: boolean;
}

export function FileUpload({
  onFileSelect,
  onClear,
  previewUrl,
  disabled = false,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateFile = useCallback((file: File): string | null => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return 'Please upload a JPEG, PNG, or WebP image';
    }
    if (file.size > MAX_FILE_SIZE) {
      return 'File size must be under 12MB';
    }
    return null;
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      setError(null);
      const validationError = validateFile(file);
      if (validationError) {
        setError(validationError);
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      onFileSelect(file, previewUrl);
    },
    [validateFile, onFileSelect]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);

      if (disabled) return;

      const file = e.dataTransfer.files[0];
      if (file) {
        handleFile(file);
      }
    },
    [disabled, handleFile]
  );

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFile(file);
      }
    },
    [handleFile]
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setError(null);
      onClear?.();
    },
    [onClear]
  );

  if (previewUrl) {
    return (
      <Card className="overflow-hidden">
        <CardContent className="p-0 relative">
          <img
            src={previewUrl}
            alt="Preview"
            className="w-full h-64 object-contain bg-muted"
          />
          <Button
            variant="destructive"
            size="icon"
            className="absolute top-2 right-2"
            onClick={handleClear}
            disabled={disabled}
          >
            <X className="h-4 w-4" />
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div
      className={`
        relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
        ${isDragging ? 'border-primary bg-primary/5' : 'border-muted-foreground/25 hover:border-muted-foreground/50'}
        ${disabled ? 'opacity-50 pointer-events-none' : ''}
      `}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={() => document.getElementById('file-input')?.click()}
    >
      <input
        id="file-input"
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        onChange={handleFileInput}
        className="hidden"
        disabled={disabled}
      />

      <div className="flex flex-col items-center gap-2">
        <div className="rounded-full bg-muted p-3">
          <Upload className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <p className="font-medium">Drop your image here</p>
          <p className="text-sm text-muted-foreground">or click to browse</p>
        </div>
        <p className="text-xs text-muted-foreground">
          JPEG, PNG, WebP up to 12MB
        </p>
      </div>

      {error && (
        <div className="absolute bottom-0 left-0 right-0 bg-destructive/90 text-destructive-foreground text-sm p-2">
          {error}
        </div>
      )}
    </div>
  );
}

interface ImagePreviewProps {
  src: string;
  alt?: string;
  className?: string;
}

export function ImagePreview({ src, alt = 'Preview', className }: ImagePreviewProps) {
  return (
    <div className={`relative ${className}`}>
      <img
        src={src}
        alt={alt}
        className="w-full h-full object-contain"
      />
    </div>
  );
}
