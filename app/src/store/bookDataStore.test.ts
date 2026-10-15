import { afterEach, expect, it } from 'vitest';
import { useBookDataStore } from './bookDataStore';

const initialBooksData = useBookDataStore.getState().booksData;

afterEach(() => {
  useBookDataStore.setState({ booksData: initialBooksData });
});

it('publishes a changed config without mutating snapshots shared by another view', () => {
  const config = { updatedAt: 1, location: 'page-one' };
  const bookData = {
    id: 'book',
    book: null,
    file: null,
    config,
    bookDoc: null,
    isFixedLayout: true,
  };
  useBookDataStore.setState({ booksData: { book: bookData } });

  useBookDataStore.getState().setConfig('book-view-one', { location: 'page-two' });

  expect(useBookDataStore.getState().getConfig('book-view-two')).toEqual({
    updatedAt: 1,
    location: 'page-two',
  });
  expect(config).toEqual({ updatedAt: 1, location: 'page-one' });
  expect(bookData.config).toBe(config);
});
