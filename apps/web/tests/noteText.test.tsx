import { render, screen } from '@testing-library/react';
import { NoteText } from '../src/components/attributes';

const view = (value: string) => render(<NoteText value={value} />).container;

describe('NoteText', () => {
  it('shows a label in semibold and the rest plain', () => {
    const root = view('Stage: seed stage\nNext line');
    const label = root.querySelector('.note__label')!;
    expect(label).toHaveTextContent('Stage:');
    expect(label.parentElement).toHaveTextContent('Stage: seed stage');
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.querySelectorAll('.note__label')).toHaveLength(1);
  });

  it('keeps a lowercase start as a plain paragraph', () => {
    expect(view('stage: x').querySelector('.note__label')).toBeNull();
  });

  it('keeps a label over 40 characters plain', () => {
    expect(view(`A${'b'.repeat(40)}: rest`).querySelector('.note__label')).toBeNull();
    expect(view(`A${'b'.repeat(39)}: rest`).querySelector('.note__label')).not.toBeNull();
  });

  it('keeps a label with a period or comma plain', () => {
    expect(view('Mr. Smith: hi').querySelector('.note__label')).toBeNull();
    expect(view('Stage, round: hi').querySelector('.note__label')).toBeNull();
  });

  it('allows parentheses, slashes, ampersands, and hyphens in a label', () => {
    expect(view('Pre-seed (US) / R&D: yes').querySelector('.note__label')).not.toBeNull();
  });

  it('keeps a label with nothing after the colon plain', () => {
    expect(view('Label:').querySelector('.note__label')).toBeNull();
    expect(view('Label:   ').querySelector('.note__label')).toBeNull();
  });

  it('renders consecutive bullet lines as one list without markers', () => {
    const root = view('- a\n* b\n• c');
    expect(root.querySelectorAll('ul')).toHaveLength(1);
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['a', 'b', 'c']);
  });

  it('adds a gap after a blank line and not after a single newline', () => {
    const root = view('One\nTwo\n\nThree');
    const lines = root.querySelectorAll('p');
    expect(lines[1]).not.toHaveClass('note__gap');
    expect(lines[2]).toHaveClass('note__gap');
    expect(lines[0]).not.toHaveClass('note__gap');
  });

  it('splits a list from the lines around it', () => {
    const root = view('Intro\n- a\n- b\nOutro');
    expect(root.querySelectorAll('p')).toHaveLength(2);
    expect(root.querySelectorAll('li')).toHaveLength(2);
  });

  it('keeps markup characters literal', () => {
    const root = view('**bold**\n# heading');
    expect(root).toHaveTextContent('**bold**');
    expect(root).toHaveTextContent('# heading');
    expect(root.querySelector('strong, b, h1, h2, h3, a')).toBeNull();
  });

  it('does not turn a URL into a link', () => {
    view('See https://example.com/page for more');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders a single line as one paragraph', () => {
    const root = view('Just one line');
    expect(root.querySelectorAll('p')).toHaveLength(1);
  });
});
