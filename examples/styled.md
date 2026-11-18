"""
#let body-font = "New Computer Modern"
#let body-size = 14pt
#let line-gap = 0.8em
#let paragraph-gap = 1.2em

#set text(font: body-font, size: body-size)
#set par(leading: line-gap, spacing: paragraph-gap)
#show heading: set text(fill: navy)
"""

# Styled math notes

This document uses the font, size, and spacing defined in its configuration header.
Change `body-size` to see the live preview update. An inline fraction: $frac(1, 2)$.

This second paragraph shows the paragraph spacing. `leading` controls the space
between lines within a paragraph; `spacing` controls the gap between paragraphs.

## A display equation

$$
sum_(k=1)^n k = n(n+1)/2
$$

```typst
#set text(size: 30pt)
// Ordinary Typst code blocks remain examples, not document configuration.
```
