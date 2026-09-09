import clsx from 'clsx';
import React, { useEffect, useState } from 'react';

import { Book } from '@/types/book';
import { BookMetadata } from '@/libs/document';
import { useEnv } from '@/context/EnvContext';
import { useThemeStore } from '@/store/themeStore';
import { useTranslation } from '@/hooks/useTranslation';
import { eventDispatcher } from '@/utils/event';
import { isWebAppPlatform } from '@/services/environment';
import Alert from '@/components/Alert';
import Dialog from '@/components/Dialog';
import BookDetailView from './BookDetailView';
import Spinner from '../Spinner';

interface BookDetailModalProps {
  book: Book;
  isOpen: boolean;
  onClose: () => void;
  handleBookDelete?: (book: Book) => void;
}

const BookDetailModal: React.FC<BookDetailModalProps> = ({
  book,
  isOpen,
  onClose,
  handleBookDelete,
}) => {
  const _ = useTranslation();
  const { envConfig, appService } = useEnv();
  const { safeAreaInsets } = useThemeStore();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [bookMeta, setBookMeta] = useState<BookMetadata | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  useEffect(() => {
    const fetchBookDetails = async () => {
      const appService = await envConfig.getAppService();
      try {
        let details = book.metadata || null;
        if (!details && book.downloadedAt) {
          details = await appService.fetchBookDetails(book);
        }
        setBookMeta(details);
        const size = await appService.getBookFileSize(book);
        setFileSize(size);
      } finally {
      }
    };
    fetchBookDetails();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  const handleClose = () => {
    setBookMeta(null);
    setShowDeleteConfirm(false);
    onClose();
  };

  const handleDelete = () => setShowDeleteConfirm(true);

  const confirmDeleteAction = async () => {
    handleClose();
    handleBookDelete?.(book);
  };

  const cancelDeleteAction = () => {
    setShowDeleteConfirm(false);
  };

  const handleBookExport = async () => {
    setIsLoading(true);
    setTimeout(async () => {
      const success = await appService?.exportBook(book);
      setIsLoading(false);
      if (!isWebAppPlatform()) {
        eventDispatcher.dispatch('toast', {
          type: success ? 'info' : 'error',
          message: success ? _('Book exported successfully.') : _('Failed to export the book.'),
        });
      }
    }, 0);
  };

  return (
    <>
      <div className='fixed inset-0 z-50 flex items-center justify-center'>
        <Dialog
          title={_('Book Details')}
          isOpen={isOpen}
          onClose={handleClose}
          boxClassName={clsx(
            'sm:min-w-[480px] sm:max-w-[480px]',
            'sm:h-auto sm:max-h-[90%]',
          )}
          contentClassName='!px-6 !py-4'
        >
          <div className='flex w-full select-text items-start justify-center'>
            <BookDetailView
              book={book}
              metadata={bookMeta}
              fileSize={fileSize}
              onDelete={handleBookDelete ? handleDelete : undefined}
              onExport={handleBookExport}
            />
          </div>
        </Dialog>

        {isLoading && (
          <div className='fixed inset-0 z-50 flex items-center justify-center'>
            <Spinner loading />
          </div>
        )}

        {showDeleteConfirm && (
          <div
            className={clsx('fixed bottom-0 left-0 right-0 z-50 flex justify-center')}
            style={{
              paddingBottom: `${(safeAreaInsets?.bottom || 0) + 16}px`,
            }}
          >
            <Alert
              title={_('Confirm Deletion')}
              message={_('Are you sure to delete the selected book?')}
              onCancel={cancelDeleteAction}
              onConfirm={confirmDeleteAction}
            />
          </div>
        )}
      </div>
    </>
  );
};

export default BookDetailModal;
