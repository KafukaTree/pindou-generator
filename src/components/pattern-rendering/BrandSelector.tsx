'use client';

import { Brand, BRANDS } from '@/lib/colors';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';

interface BrandSelectorProps {
  value: Brand;
  onChange: (value: Brand) => void;
  disabled?: boolean;
}

export function BrandSelector({ value, onChange, disabled }: BrandSelectorProps) {
  return (
    <div className="space-y-2">
      <Label>Brand</Label>
      <Select
        value={value}
        onValueChange={(v) => onChange(v as Brand)}
        disabled={disabled}
      >
        <SelectTrigger>
          <SelectValue placeholder="Select brand" />
        </SelectTrigger>
        <SelectContent>
          {BRANDS.map((brand) => (
            <SelectItem key={brand} value={brand}>
              {brand}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
