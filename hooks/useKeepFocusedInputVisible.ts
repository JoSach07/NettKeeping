import { RefObject, useCallback, useEffect, useRef } from 'react';
import {
  Keyboard,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

// Space kept between the focused input and the edge of the visible area, so
// the field isn't flush against the keyboard or the panel border.
const visibleMargin = 16;

// Keeps the focused TextInput inside a ScrollView's visible area when that
// area gets SMALLER — i.e. when the keyboard opens and the panel/screen around
// the ScrollView shrinks.
//
// Why it is needed: Android does scroll a focused child into view, but only at
// the moment it gains focus. Tapping a field near the bottom focuses it while
// it is still visible; the keyboard then opens and the ScrollView shrinks, and
// nothing scrolls again, so the field ends up just below the visible edge.
//
// It deliberately does NOT use the keyboard's screen coordinates. It only
// compares the input's position with the ScrollView's own viewport, so it
// works the same whichever mechanism shrank the view (KeyboardAvoidingView or
// Android resizing the modal window). An input that is not inside this
// ScrollView (e.g. a picker's search box) fails measureLayout and is ignored.
//
// Usage: const keepVisible = useKeepFocusedInputVisible();
//        <ScrollView {...keepVisible.scrollViewProps}>...</ScrollView>
// Don't also pass ref / innerViewRef / onLayout / onScroll to that ScrollView.
export function useKeepFocusedInputVisible() {
  const scrollRef = useRef<ScrollView>(null);
  const innerViewRef = useRef<View>(null);
  const viewportHeightRef = useRef(0);
  const scrollYRef = useRef(0);

  const ensureFocusedInputVisible = useCallback(() => {
    // Wait a frame so the layout that triggered this has been applied.
    requestAnimationFrame(() => {
      const scroll = scrollRef.current;
      const innerView = innerViewRef.current;
      const input = TextInput.State.currentlyFocusedInput();
      const viewportHeight = viewportHeightRef.current;

      if (!scroll || !innerView || !input || viewportHeight <= 0) {
        return;
      }

      input.measureLayout(
        innerView,
        (_x, y, _width, height) => {
          const visibleTop = scrollYRef.current;
          const visibleBottom = visibleTop + viewportHeight;
          const inputTop = y - visibleMargin;
          const inputBottom = y + height + visibleMargin;

          if (inputBottom > visibleBottom) {
            scroll.scrollTo({ y: inputBottom - viewportHeight, animated: true });
          } else if (inputTop < visibleTop) {
            scroll.scrollTo({ y: Math.max(0, inputTop), animated: true });
          }
        },
        () => {
          // Focused input is outside this ScrollView — not ours to handle.
        }
      );
    });
  }, []);

  useEffect(() => {
    // Covers the case where the view had already shrunk before the keyboard
    // finished opening, so no further onLayout arrives afterwards.
    const subscription = Keyboard.addListener('keyboardDidShow', ensureFocusedInputVisible);
    return () => subscription.remove();
  }, [ensureFocusedInputVisible]);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = event.nativeEvent.layout.height;
      const shrank = viewportHeightRef.current > 0 && nextHeight < viewportHeightRef.current;
      viewportHeightRef.current = nextHeight;

      if (shrank) {
        ensureFocusedInputVisible();
      }
    },
    [ensureFocusedInputVisible]
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  return {
    scrollViewProps: {
      // RN's typings declare this prop as RefObject<View> (non-null current),
      // while useRef(null) yields RefObject<View | null>.
      innerViewRef: innerViewRef as RefObject<View>,
      onLayout,
      onScroll,
      ref: scrollRef,
      scrollEventThrottle: 16,
    },
  };
}
