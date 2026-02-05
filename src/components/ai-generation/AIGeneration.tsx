'use client';

import { useState, useCallback } from 'react';
import { Sparkles, Key, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';

const AI_PROVIDERS = [
  { id: 'doubao', name: '豆包', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'qwen', name: '通义千问', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' },
  { id: 'custom', name: 'Custom', endpoint: '' },
] as const;

export type AIProvider = (typeof AI_PROVIDERS)[number]['id'];

interface AIGenerationProps {
  onImageGenerated: (imageUrl: string) => void;
  disabled?: boolean;
}

export function AIGeneration({ onImageGenerated, disabled }: AIGenerationProps) {
  const [apiKey, setApiKey] = useState('');
  const [provider, setProvider] = useState<AIProvider>('doubao');
  const [customEndpoint, setCustomEndpoint] = useState('');
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getEndpoint = useCallback(() => {
    if (provider === 'custom') {
      return customEndpoint;
    }
    return AI_PROVIDERS.find(p => p.id === provider)?.endpoint || '';
  }, [provider, customEndpoint]);

  const handleGenerate = useCallback(async () => {
    if (!apiKey.trim()) {
      setError('Please enter your API key');
      return;
    }

    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    const endpoint = getEndpoint();
    if (!endpoint && provider !== 'custom') {
      setError('Please select a provider');
      return;
    }

    setError(null);
    setIsGenerating(true);

    try {
      const modelMap: Record<AIProvider, string> = {
        doubao: 'doubao-pro-128k',
        qwen: 'qwen-vl-plus',
        openai: 'gpt-4o',
        custom: 'gpt-4o',
      };

      const response = await fetch(endpoint + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: modelMap[provider],
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: prompt,
                },
                {
                  type: 'text',
                  text: '\n\nIMPORTANT: Generate ONLY the image. Do not include any text explanations, markdown formatting, or code blocks in your response. Just return the image directly.',
                },
              ],
            },
          ],
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 401) {
          throw new Error('Invalid API key');
        } else if (response.status === 429) {
          throw new Error('Rate limit exceeded. Please try again later.');
        } else {
          throw new Error(errorData.error?.message || `API error: ${response.status}`);
        }
      }

      const data = await response.json();

      // Try to extract image URL from various response formats
      let imageUrl: string | null = null;

      // Check for image_url in response (OpenAI format)
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        // Try to parse as JSON for image_url
        try {
          const parsed = typeof content === 'string' ? JSON.parse(content) : content;
          imageUrl = parsed.image_url?.url || parsed.url || null;
        } catch {
          // Not JSON, might be direct URL
          if (typeof content === 'string' && (content.startsWith('http://') || content.startsWith('https://'))) {
            imageUrl = content;
          }
        }
      }

      // Check for base64 images
      if (!imageUrl && data.choices?.[0]?.message?.content?.[0]?.image_url?.url) {
        imageUrl = data.choices[0].message.content[0].image_url.url;
      }

      if (!imageUrl) {
        throw new Error('Could not extract image from response. Please check your API settings.');
      }

      toast.success('Image generated successfully!');
      onImageGenerated(imageUrl);
      setPrompt('');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to generate image';
      setError(errorMessage);
      toast.error(errorMessage);
    } finally {
      setIsGenerating(false);
    }
  }, [apiKey, prompt, provider, customEndpoint, getEndpoint, onImageGenerated]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5" />
          AI Image Generation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="provider">AI Provider</Label>
          <select
            id="provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as AIProvider)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            disabled={disabled}
          >
            {AI_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        {provider === 'custom' && (
          <div className="space-y-2">
            <Label htmlFor="endpoint">Custom Endpoint</Label>
            <Input
              id="endpoint"
              type="url"
              placeholder="https://your-api-endpoint.com/v1"
              value={customEndpoint}
              onChange={(e) => setCustomEndpoint(e.target.value)}
              disabled={disabled}
            />
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="api-key" className="flex items-center gap-2">
            <Key className="h-4 w-4" />
            API Key
          </Label>
          <Input
            id="api-key"
            type="password"
            placeholder="Enter your API key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={disabled}
          />
          <p className="text-xs text-muted-foreground">
            Your API key is used directly and never stored.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="prompt">Prompt</Label>
          <textarea
            id="prompt"
            placeholder="Describe the image you want to generate..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[100px]"
            disabled={disabled}
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        <Button
          onClick={handleGenerate}
          disabled={disabled || isGenerating}
          className="w-full"
        >
          {isGenerating ? (
            <>
              <Sparkles className="mr-2 h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              Generate Image
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
