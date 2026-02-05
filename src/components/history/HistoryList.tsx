'use client';

import { useState } from 'react';
import { History, Trash2, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { PatternHistoryItem, useHistory } from '@/hooks/useHistory';
import { Brand } from '@/lib/colors';

interface HistoryListProps {
  onRestore: (item: PatternHistoryItem) => void;
}

export function HistoryList({ onRestore }: HistoryListProps) {
  const { history, isLoaded, removeFromHistory, clearHistory } = useHistory();
  const [isOpen, setIsOpen] = useState(false);

  if (!isLoaded) {
    return null;
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();

    if (diff < 60000) {
      return 'Just now';
    } else if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    } else if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="mr-2 h-4 w-4" />
          History ({history.length})
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            Pattern History
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearHistory}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Clear All
              </Button>
            )}
          </DialogTitle>
        </DialogHeader>

        {history.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <History className="mx-auto h-12 w-12 mb-4 opacity-50" />
            <p>No patterns saved yet</p>
            <p className="text-sm">Your recent patterns will appear here</p>
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {history.map((item) => (
              <Card key={item.id} className="cursor-pointer hover:bg-muted/50 transition-colors">
                <CardContent className="p-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={item.previewUrl}
                      alt="Pattern preview"
                      className="w-16 h-16 object-cover rounded"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium truncate">
                          {item.settings.brand} - {item.settings.gridSize}×{item.settings.gridSize}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeFromHistory(item.id);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {formatDate(item.timestamp)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {item.settings.colorCount} colors
                      </div>
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full mt-2"
                    onClick={() => {
                      onRestore(item);
                      setIsOpen(false);
                    }}
                  >
                    Restore Pattern
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
