import { Card, CardContent, CardHeader, CardTitle } from '@arcaai/ui/card';
import { Badge } from '@arcaai/ui/badge';
import { Button } from '@arcaai/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@arcaai/ui/tooltip';
import { Check, Clock, Copy, Download, Sparkles, Zap } from 'lucide-react';
import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type { TokenUsage } from '../api';

interface ResultCardProps {
  title: string;
  content: string;
  provider?: string;
  model?: string;
  processingTimeMs?: number;
  tokenUsage?: TokenUsage;
  createdAt?: string;
  variant?: 'pre-summary' | 'summary';
  onUseAsContext?: (content: string) => void;
}

export function ResultCard({
  title,
  content,
  provider,
  model,
  processingTimeMs,
  tokenUsage,
  createdAt,
  variant = 'summary',
  onUseAsContext,
}: ResultCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    });
  }, [content]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${variant}-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Downloaded');
  }, [content, variant]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className={`size-4 ${variant === 'pre-summary' ? 'text-amber-500' : 'text-blue-500'}`} />
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            <Badge variant={variant === 'pre-summary' ? 'secondary' : 'default'} className="text-[10px]">
              {variant === 'pre-summary' ? 'Pre-Summary' : 'Summary'}
            </Badge>
          </div>
          <div className="flex items-center gap-1">
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7" onClick={handleCopy}>
                    {copied ? <Check className="size-3.5 text-green-500" /> : <Copy className="size-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? 'Copied!' : 'Copy'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-7" onClick={handleDownload}>
                    <Download className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {onUseAsContext && (
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-7" onClick={() => onUseAsContext(content)}>
                      <Zap className="size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Use as context for summary</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {provider && model && (
            <Badge variant="outline" className="text-[10px] font-mono">
              {provider}/{model}
            </Badge>
          )}
          {processingTimeMs != null && (
            <span className="text-muted-foreground flex items-center gap-1">
              <Clock className="size-3" />
              {(processingTimeMs / 1000).toFixed(1)}s
            </span>
          )}
          {tokenUsage && <span className="text-muted-foreground">{tokenUsage.total_tokens.toLocaleString()} tokens</span>}
          {createdAt && <span className="text-muted-foreground">{new Date(createdAt).toLocaleString()}</span>}
        </div>
      </CardHeader>
      <CardContent>
        <div className="bg-muted/30 max-h-96 overflow-y-auto rounded-lg border p-4">
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
        </div>
      </CardContent>
    </Card>
  );
}
