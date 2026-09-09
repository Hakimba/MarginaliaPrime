import clsx from 'clsx';
import { useCallback } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useSettingsStore } from '@/store/settingsStore';
import { useTranslation } from '@/hooks/useTranslation';
import { useAppRouter } from '@/hooks/useAppRouter';
import { useLongPress } from '@/hooks/useLongPress';
import { Menu, MenuItem } from '@tauri-apps/api/menu';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { eventDispatcher } from '@/utils/event';
import { getOSPlatform } from '@/utils/misc';
import { throttle } from '@/utils/throttle';
import { navigateToReader, showReaderWindow } from '@/utils/nav';
import { LibraryCoverFitType, LibraryViewModeType } from '@/types/settings';
import { BOOK_UNGROUPED_ID, BOOK_UNGROUPED_NAME } from '@/services/constants';
import { FILE_REVEAL_LABELS, FILE_REVEAL_PLATFORMS } from '@/utils/os';
import { Book, BooksGroup, ReadingStatus } from '@/types/book';
import { md5Fingerprint } from '@/utils/md5';
import BookItem from './BookItem';
import GroupItem from './GroupItem';

export const generateBookshelfItems = (
  books: Book[],
  parentGroupName: string,
): (Book | BooksGroup)[] => {
  const groupsMap = new Map<string, BooksGroup>();

  for (const book of books) {
    if (book.deletedAt) continue;

    const groupName = book.groupName || BOOK_UNGROUPED_NAME;
    if (
      parentGroupName &&
      groupName !== parentGroupName &&
      !groupName.startsWith(parentGroupName + '/')
    ) {
      continue;
    }

    const relativePath = parentGroupName ? groupName.slice(parentGroupName.length + 1) : groupName;
    // Get the immediate child group name (or empty if book is directly in parent)
    const slashIndex = relativePath.indexOf('/');
    const immediateChild = slashIndex > 0 ? relativePath.slice(0, slashIndex) : relativePath;
    // Determine if this book belongs directly to the parent group
    const isDirectChild =
      groupName === parentGroupName || (groupName === BOOK_UNGROUPED_NAME && !parentGroupName);
    // Build the full group name for this level
    const fullGroupName = isDirectChild
      ? BOOK_UNGROUPED_NAME
      : parentGroupName
        ? `${parentGroupName}/${immediateChild}`
        : immediateChild;

    const mapKey = fullGroupName;
    const existingGroup = groupsMap.get(mapKey);
    if (existingGroup) {
      existingGroup.books.push(book);
      existingGroup.updatedAt = Math.max(existingGroup.updatedAt, book.updatedAt);
    } else {
      groupsMap.set(mapKey, {
        id: isDirectChild ? BOOK_UNGROUPED_ID : md5Fingerprint(fullGroupName),
        name: fullGroupName,
        displayName: isDirectChild ? BOOK_UNGROUPED_NAME : immediateChild,
        books: [book],
        updatedAt: book.updatedAt,
      });
    }
  }

  for (const group of groupsMap.values()) {
    group.books.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const ungroupedGroup = groupsMap.get(BOOK_UNGROUPED_NAME);
  const ungroupedBooks = ungroupedGroup?.books || [];
  const groupedBooks = Array.from(groupsMap.values()).filter(
    (group) => group.name !== BOOK_UNGROUPED_NAME,
  );

  return [...ungroupedBooks, ...groupedBooks].sort((a, b) => b.updatedAt - a.updatedAt);
};

interface BookshelfItemProps {
  mode: LibraryViewModeType;
  item: Book | BooksGroup;
  coverFit: LibraryCoverFitType;
  isSelectMode: boolean;
  itemSelected: boolean;
  toggleSelection: (hash: string) => void;
  handleGroupBooks: () => void;
  handleBookDelete: (book: Book) => Promise<boolean>;
  handleSetSelectMode: (selectMode: boolean) => void;
  handleShowDetailsBook: (book: Book) => void;
  handleLibraryNavigation: (targetGroup: string) => void;
  handleUpdateReadingStatus: (book: Book, status: ReadingStatus | undefined) => void;
}

const BookshelfItem: React.FC<BookshelfItemProps> = ({
  mode,
  item,
  coverFit,
  isSelectMode,
  itemSelected,
  toggleSelection,
  handleGroupBooks,
  handleSetSelectMode,
  handleShowDetailsBook,
  handleLibraryNavigation,
  handleUpdateReadingStatus,
}) => {
  const _ = useTranslation();
  const router = useAppRouter();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();

  const showBookDetailsModal = useCallback(async (book: Book) => {
    handleShowDetailsBook(book);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBookClick = useCallback(
    async (book: Book) => {
      if (isSelectMode) {
        toggleSelection(book.hash);
      } else if (appService?.hasWindow && settings.openBookInNewWindow) {
        showReaderWindow(appService, [book.hash]);
      } else {
        setTimeout(() => {
          navigateToReader(router, [book.hash]);
        }, 0);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSelectMode, settings.openBookInNewWindow, appService],
  );

  const handleGroupClick = useCallback(
    (group: BooksGroup) => {
      if (isSelectMode) {
        toggleSelection(group.id);
      } else {
        handleLibraryNavigation(group.id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isSelectMode, handleLibraryNavigation],
  );

  const bookContextMenuHandler = async (book: Book) => {
    if (!appService?.hasContextMenu) return;
    const osPlatform = getOSPlatform();
    const fileRevealLabel =
      FILE_REVEAL_LABELS[osPlatform as FILE_REVEAL_PLATFORMS] || FILE_REVEAL_LABELS.default;
    const selectBookMenuItem = await MenuItem.new({
      text: itemSelected ? _('Deselect Book') : _('Select Book'),
      action: async () => {
        if (!isSelectMode) handleSetSelectMode(true);
        toggleSelection(book.hash);
      },
    });
    const groupBooksMenuItem = await MenuItem.new({
      text: _('Group Books'),
      action: async () => {
        if (!isSelectMode) handleSetSelectMode(true);
        if (!itemSelected) {
          toggleSelection(book.hash);
        }
        handleGroupBooks();
      },
    });
    const markAsFinishedMenuItem = await MenuItem.new({
      text: _('Mark as Finished'),
      action: async () => {
        handleUpdateReadingStatus(book, 'finished');
      },
    });
    const markAsUnreadMenuItem = await MenuItem.new({
      text: _('Mark as Unread'),
      action: async () => {
        handleUpdateReadingStatus(book, 'unread');
      },
    });
    const clearStatusMenuItem = await MenuItem.new({
      text: _('Clear Status'),
      action: async () => {
        handleUpdateReadingStatus(book, undefined);
      },
    });
    const showBookInFinderMenuItem = await MenuItem.new({
      text: _(fileRevealLabel),
      action: async () => {
        const folder = `${settings.localBooksDir}/${book.hash}`;
        revealItemInDir(folder);
      },
    });
    const showBookDetailsMenuItem = await MenuItem.new({
      text: _('Show Book Details'),
      action: async () => {
        showBookDetailsModal(book);
      },
    });
    const deleteBookMenuItem = await MenuItem.new({
      text: _('Delete'),
      action: async () => {
        eventDispatcher.dispatch('delete-books', { ids: [book.hash] });
      },
    });
    const menu = await Menu.new();
    menu.append(selectBookMenuItem);
    menu.append(groupBooksMenuItem);
    if (book.readingStatus === 'finished') {
      menu.append(markAsUnreadMenuItem);
    } else {
      menu.append(markAsFinishedMenuItem);
    }
    // show "Clear Status" option when book has an explicit status set
    if (book.readingStatus === 'finished' || book.readingStatus === 'unread') {
      menu.append(clearStatusMenuItem);
    }
    menu.append(showBookDetailsMenuItem);
    menu.append(showBookInFinderMenuItem);
    menu.append(deleteBookMenuItem);
    menu.popup();
  };

  const groupContextMenuHandler = async (group: BooksGroup) => {
    if (!appService?.hasContextMenu) return;
    const selectGroupMenuItem = await MenuItem.new({
      text: itemSelected ? _('Deselect Group') : _('Select Group'),
      action: async () => {
        if (!isSelectMode) handleSetSelectMode(true);
        toggleSelection(group.id);
      },
    });
    const groupBooksMenuItem = await MenuItem.new({
      text: _('Group Books'),
      action: async () => {
        if (!isSelectMode) handleSetSelectMode(true);
        if (!itemSelected) {
          toggleSelection(group.id);
        }
        handleGroupBooks();
      },
    });
    const deleteGroupMenuItem = await MenuItem.new({
      text: _('Delete'),
      action: async () => {
        eventDispatcher.dispatch('delete-books', { ids: [group.id] });
      },
    });
    const menu = await Menu.new();
    menu.append(selectGroupMenuItem);
    menu.append(groupBooksMenuItem);
    menu.append(deleteGroupMenuItem);
    menu.popup();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleSelectItem = useCallback(
    throttle(() => {
      if (!isSelectMode) {
        handleSetSelectMode(true);
      }
      if ('format' in item) {
        toggleSelection((item as Book).hash);
      } else {
        toggleSelection((item as BooksGroup).id);
      }
    }, 100),
    [isSelectMode],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleOpenItem = useCallback(
    throttle(() => {
      if (isSelectMode) {
        handleSelectItem();
        return;
      }
      if ('format' in item) {
        handleBookClick(item as Book);
      } else {
        handleGroupClick(item as BooksGroup);
      }
    }, 100),
    [handleSelectItem, handleBookClick, handleGroupClick],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const handleContextMenu = useCallback(
    throttle(() => {
      if ('format' in item) {
        bookContextMenuHandler(item as Book);
      } else {
        groupContextMenuHandler(item as BooksGroup);
      }
    }, 100),
    [itemSelected, settings.localBooksDir],
  );

  const { pressing, handlers } = useLongPress(
    {
      onLongPress: () => {
        handleSelectItem();
      },
      onTap: () => {
        handleOpenItem();
      },
      onContextMenu: () => {
        if (appService?.hasContextMenu) {
          handleContextMenu();
        } else if (appService?.isAndroidApp) {
          handleSelectItem();
        }
      },
    },
    [isSelectMode, handleSelectItem, handleOpenItem, handleContextMenu],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpenItem();
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      handleContextMenu();
    }
  };

  return (
    <div className={clsx(mode === 'list' && 'sm:hover:bg-base-300/50 px-4 sm:px-6')}>
      <div
        className={clsx(
          'visible-focus-inset-2 group',
          mode === 'grid' &&
            'sm:hover:bg-base-300/50 flex h-full flex-col px-0 py-2 sm:px-4 sm:py-4',
          mode === 'list' && 'border-base-300 flex flex-col border-b py-2',
          appService?.isMobileApp && 'no-context-menu',
          pressing && mode === 'grid' ? 'not-eink:scale-95' : 'scale-100',
        )}
        role='button'
        tabIndex={0}
        aria-label={'format' in item ? item.title : item.name}
        style={{
          transition: 'transform 0.2s',
        }}
        onKeyDown={handleKeyDown}
        {...handlers}
      >
        <div className='flex h-full flex-col justify-end'>
          {'format' in item ? (
            <BookItem
              mode={mode}
              book={item}
              coverFit={coverFit}
              isSelectMode={isSelectMode}
              bookSelected={itemSelected}
              showBookDetailsModal={showBookDetailsModal}
            />
          ) : (
            <GroupItem
              mode={mode}
              group={item}
              isSelectMode={isSelectMode}
              groupSelected={itemSelected}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default BookshelfItem;
